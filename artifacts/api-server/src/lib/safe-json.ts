import { stat, writeFile } from "node:fs/promises";

/**
 * Thrown by `serializeJsonSafe` / `writeJsonFileSafe` when the value cannot
 * be safely turned into JSON (undefined input, wrong shape, non-string
 * stringify result, literal "undefined" output, or roundtrip parse error).
 *
 * The export route catches this and returns HTTP 500 with the exact message
 * the user requested:
 *   "Export failed: export data was undefined before file write."
 */
export class SafeJsonError extends Error {
  public readonly safeJsonName: string;
  public readonly cause?: unknown;
  constructor(name: string, message: string, cause?: unknown) {
    super(message);
    this.name = "SafeJsonError";
    this.safeJsonName = name;
    this.cause = cause;
  }
}

export interface SerializeOptions {
  /**
   * If set, the value MUST be of the requested top-level shape:
   *   - "array"  -> Array.isArray(value) === true
   *   - "object" -> non-null, non-array plain object
   * This catches accidental `undefined` -> JSON.stringify -> "undefined"
   * paths AND structural mistakes like an empty manifest being an array.
   */
  expect?: "array" | "object";
  /** Pretty-print with 2-space indent (default true). */
  pretty?: boolean;
}

function assertJsonSafeValue(
  value: unknown,
  name: string,
  path: string,
  ancestors: WeakSet<object>,
): void {
  if (value === undefined) {
    throw new SafeJsonError(
      name,
      `Refusing to serialize undefined value for "${name}" at ${path}.`,
    );
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new SafeJsonError(
      name,
      `Refusing to serialize ${typeof value} value for "${name}" at ${path}.`,
    );
  }
  if (typeof value === "bigint") {
    throw new SafeJsonError(
      name,
      `Refusing to serialize bigint value for "${name}" at ${path}.`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new SafeJsonError(
      name,
      `Refusing to serialize non-finite number for "${name}" at ${path}.`,
    );
  }
  if (value === null) {
    if (path === "$") {
      throw new SafeJsonError(
        name,
        `Refusing to serialize null root value for "${name}".`,
      );
    }
    return;
  }
  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  if (ancestors.has(obj)) {
    throw new SafeJsonError(
      name,
      `Refusing to serialize circular reference for "${name}" at ${path}.`,
    );
  }

  ancestors.add(obj);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        assertJsonSafeValue(value[i], name, `${path}[${i}]`, ancestors);
      }
      return;
    }

    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key === "symbol") {
        throw new SafeJsonError(
          name,
          `Refusing to serialize symbol-keyed property for "${name}" at ${path}.`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      if (!descriptor?.enumerable) continue;
      assertJsonSafeValue(obj[key], name, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(obj);
  }
}

function assertExportManifestNotFailed(data: unknown, name: string): void {
  if (name !== "export_manifest.json") return;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return;
  const manifest = data as {
    validation_status?: unknown;
    validation_errors?: unknown;
  };
  if (manifest.validation_status !== "failed") return;

  const validationErrors = Array.isArray(manifest.validation_errors)
    ? manifest.validation_errors.map((entry) => String(entry))
    : [];
  throw new SafeJsonError(
    name,
    [
      "Export validation failed; refusing to serialize export_manifest.json.",
      ...validationErrors,
    ].join(" "),
  );
}

/**
 * Serialize `data` to a JSON string, refusing to ever return the literal
 * token "undefined" or to write a value that fails a JSON.parse roundtrip.
 *
 * This is the single chokepoint that prevents the regression where
 * `archive.append(JSON.stringify(undefined), ...)` ended up writing the
 * literal four-character string `undefined` into ZIP entries like
 * `full_export.json` and `export_manifest.json`.
 */
export function serializeJsonSafe(
  data: unknown,
  name: string,
  opts: SerializeOptions = {},
): string {
  if (data === undefined) {
    throw new SafeJsonError(
      name,
      `Refusing to serialize undefined value for "${name}".`,
    );
  }
  if (data === null) {
    throw new SafeJsonError(
      name,
      `Refusing to serialize null root value for "${name}".`,
    );
  }
  if (opts.expect === "array" && !Array.isArray(data)) {
    throw new SafeJsonError(
      name,
      `Expected an array for "${name}", got ${
        data === null ? "null" : typeof data
      }.`,
    );
  }
  if (
    opts.expect === "object" &&
    (data === null || typeof data !== "object" || Array.isArray(data))
  ) {
    throw new SafeJsonError(
      name,
      `Expected a plain object for "${name}", got ${
        data === null
          ? "null"
          : Array.isArray(data)
            ? "array"
            : typeof data
      }.`,
    );
  }
  assertJsonSafeValue(data, name, "$", new WeakSet<object>());
  assertExportManifestNotFailed(data, name);
  let str: string | undefined;
  try {
    str = JSON.stringify(data, null, opts.pretty === false ? undefined : 2);
  } catch (err) {
    throw new SafeJsonError(
      name,
      `JSON.stringify threw for "${name}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
  // JSON.stringify(undefined) returns the JS value `undefined` (not the
  // string "undefined"); JSON.stringify(() => 0) likewise returns
  // undefined. Catch that explicitly so archiver never gets handed
  // anything that String()-coerces to "undefined".
  if (typeof str !== "string") {
    throw new SafeJsonError(
      name,
      `JSON.stringify returned ${str === undefined ? "undefined" : typeof str} for "${name}".`,
    );
  }
  if (str === "undefined" || str.trim() === "undefined") {
    throw new SafeJsonError(
      name,
      `Serialized JSON for "${name}" is the literal token "undefined".`,
    );
  }
  // Roundtrip parse: if our own output is not valid JSON we must not write
  // it. This costs O(n) but is cheap relative to the network/zip work.
  try {
    JSON.parse(str);
  } catch (err) {
    throw new SafeJsonError(
      name,
      `Roundtrip JSON.parse failed for "${name}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
  return str;
}

/**
 * Write `data` as JSON to `filePath`, validating it via `serializeJsonSafe`
 * first and then verifying the on-disk byte size is greater than 2 (i.e.
 * we did not write `[]` or `{}` when we expected real content). Returns
 * the absolute path and byte size; logs the same to the supplied logger.
 *
 * This helper is exported for any caller that needs to write a loose JSON
 * file to disk. The export route itself does NOT write loose JSON files —
 * its JSON entries are streamed inside a ZIP — but the same
 * `serializeJsonSafe` chokepoint is used in both code paths so the
 * "no undefined ever reaches disk" guarantee holds either way.
 */
export async function writeJsonFileSafe(
  filePath: string,
  data: unknown,
  opts: SerializeOptions & {
    logger?: (info: { filePath: string; bytes: number }) => void;
    /** Treat byte sizes <= this as suspicious and fail (default 2). */
    minBytes?: number;
  } = {},
): Promise<{ filePath: string; bytes: number }> {
  const str = serializeJsonSafe(data, filePath, opts);
  await writeFile(filePath, str, "utf-8");
  const st = await stat(filePath);
  const minBytes = opts.minBytes ?? 2;
  if (st.size <= minBytes) {
    throw new SafeJsonError(
      filePath,
      `Wrote suspiciously small JSON file (${st.size} bytes <= ${minBytes}) to ${filePath}.`,
    );
  }
  if (opts.logger) opts.logger({ filePath, bytes: st.size });
  return { filePath, bytes: st.size };
}

/**
 * @deprecated Belt-and-braces scanner kept only for backwards
 * compatibility with code that already imports it. The
 * `JSON.parse(JSON.stringify(...))` roundtrip inside `serializeJsonSafe`
 * already rejects every JSON-grammar case where a bare `undefined` token
 * could appear at value position (because `JSON.parse("undefined")` and
 * `JSON.parse("[undefined]")` both throw `SyntaxError`). A naive regex
 * scanner over the serialized text is NOT string-aware and can
 * false-positive on legitimate email-body content containing substrings
 * like `[undefined]` or `: undefined,`. So this helper is now a no-op;
 * trust `serializeJsonSafe` instead.
 */
export function assertNoLiteralUndefinedToken(
  _jsonString: string,
  _name: string,
): void {
  // Intentionally empty — see deprecation note above.
}
