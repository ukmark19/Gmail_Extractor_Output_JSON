import archiver, { type Archiver } from "archiver";
import type { Writable } from "stream";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

/**
 * Single source of truth for the export build marker. Bumped any time a
 * runtime change must invalidate previously persisted `latest.zip` copies
 * (so the /api/gmail/export/latest endpoint refuses to serve a stale
 * artifact whose sidecar is missing or carries an older marker).
 *
 * Currently bumped for: OCR runtime path resolution + dependency-probe
 * gating fix.
 */
export const EXPORT_BUILD_MARKER = "ocr-runtime-fix-v1" as const;

/** Sidecar filename written next to latest.zip in the per-user latest dir. */
export const BUILD_MARKER_SIDECAR_FILENAME = "build_marker.json";

export interface BuildMarkerSidecar {
  build_marker: string;
  export_id: string;
  created_at: string;
}

export interface AttachmentBufferEntry {
  storagePath: string; // e.g. extracted_attachments/<msg>/<...>
  buffer: Buffer;
}

export interface OcrImageEntry {
  /** message id of the parent email */
  messageId: string;
  /** Gmail attachment id */
  attachmentId: string;
  /** 1-based page number in the source PDF */
  pageNumber: number;
  /** Raw PNG bytes for the rasterised page */
  png: Buffer;
}

/**
 * Pre-serialized JSON entries the streamer will write into the ZIP.
 *
 * The route is responsible for serializing each section via
 * `serializeJsonSafe` BEFORE calling the streamer. The streamer never
 * calls `JSON.stringify` itself, which is what guarantees we cannot
 * regress to writing the literal string "undefined" into a JSON entry
 * (the original bug). Each field MUST be a non-empty string.
 */
export interface SerializedBundleEntries {
  fullExportJson: string;
  aiIngestion: string; // JSONL — one JSON object per line, newline-separated
  attachmentsIndexJson: string;
  manifestJson: string;
  processingLogJson: string;
  errorsReportJson: string;
}

function assertNonEmptyString(value: unknown, fieldName: string): void {
  if (typeof value !== "string") {
    throw new Error(
      `streamExportZip: "${fieldName}" must be a string, got ${
        value === undefined ? "undefined" : value === null ? "null" : typeof value
      }.`,
    );
  }
  if (value.length === 0) {
    throw new Error(`streamExportZip: "${fieldName}" must not be empty.`);
  }
}

function assertValidJsonString(value: unknown, fieldName: string): void {
  assertNonEmptyString(value, fieldName);
  const json = value as string;
  if (json.trim() === "undefined") {
    throw new Error(
      `streamExportZip: "${fieldName}" must not be the literal token undefined.`,
    );
  }
  try {
    JSON.parse(json);
  } catch (err) {
    throw new Error(
      `streamExportZip: "${fieldName}" is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function assertValidJsonLines(value: unknown, fieldName: string): void {
  assertNonEmptyString(value, fieldName);
  const lines = (value as string).split("\n").filter((line) => line.length > 0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "undefined") {
      throw new Error(
        `streamExportZip: "${fieldName}" line ${i + 1} must not be undefined.`,
      );
    }
    try {
      JSON.parse(line);
    } catch (err) {
      throw new Error(
        `streamExportZip: "${fieldName}" line ${i + 1} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function ensureJsonValidationCompletedEvent(processingLogJson: string): string {
  const parsed = JSON.parse(processingLogJson) as unknown;
  if (!Array.isArray(parsed)) return processingLogJson;
  if (
    parsed.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as { event_type?: unknown }).event_type ===
          "export_json_validation_completed",
    )
  ) {
    return processingLogJson;
  }

  const fileValidationIndex = parsed.findIndex(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as { event_type?: unknown }).event_type ===
        "export_file_validation_completed",
  );
  if (fileValidationIndex === -1) return processingLogJson;

  const source = parsed[fileValidationIndex];
  if (!source || typeof source !== "object") return processingLogJson;
  parsed.splice(fileValidationIndex + 1, 0, {
    ...(source as Record<string, unknown>),
    event_type: "export_json_validation_completed",
  });
  return JSON.stringify(parsed, null, 2);
}

/**
 * Stream the export bundle as a ZIP into the supplied writable.
 * The ZIP is rooted at `<rootDirName>/` and contains:
 *   - full_export.json
 *   - ai_ingestion.jsonl
 *   - attachments_index.json
 *   - export_manifest.json
 *   - processing_log.json
 *   - errors_report.json
 *   - extracted_attachments/<messageId>/<partIdx>_<sha8>_<safe_filename>
 *   - ocr_images/<messageId>/<attachmentId>/page_<n>.png  (when PDF was rasterised)
 */
export async function streamExportZip(
  entries: SerializedBundleEntries,
  attachmentBuffers: AttachmentBufferEntry[],
  rootDirName: string,
  out: Writable,
  ocrImages: OcrImageEntry[] = [],
): Promise<{ bytesWritten: number; entryCount: number }> {
  // Belt-and-braces: refuse to even start the archive if the caller forgot
  // to pre-serialize a section. Without this, archiver would happily
  // String()-coerce undefined into the literal text "undefined" (the
  // original bug). The route already validates upstream, but doing this
  // here too means no future caller can re-introduce the regression.
  assertValidJsonString(entries.fullExportJson, "fullExportJson");
  assertValidJsonLines(entries.aiIngestion, "aiIngestion");
  assertValidJsonString(entries.attachmentsIndexJson, "attachmentsIndexJson");
  assertValidJsonString(entries.manifestJson, "manifestJson");
  const processingLogJson = ensureJsonValidationCompletedEvent(
    entries.processingLogJson,
  );
  assertValidJsonString(processingLogJson, "processingLogJson");
  assertValidJsonString(entries.errorsReportJson, "errorsReportJson");

  return new Promise((resolve, reject) => {
    const archive: Archiver = archiver("zip", { zlib: { level: 6 } });
    let entryCount = 0;

    archive.on("warning", (err) => {
      // ENOENT is non-fatal; surface everything else
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        reject(err);
      }
    });
    archive.on("error", (err) => reject(err));
    archive.on("entry", () => {
      entryCount++;
    });

    out.on("close", () => {
      resolve({ bytesWritten: archive.pointer(), entryCount });
    });
    out.on("finish", () => {
      // For HTTP responses, finish fires before close; resolve here too.
      resolve({ bytesWritten: archive.pointer(), entryCount });
    });
    out.on("error", (err) => reject(err));

    archive.pipe(out);

    const root = rootDirName.replace(/\/+$/, "");

    archive.append(entries.fullExportJson, {
      name: `${root}/full_export.json`,
    });
    archive.append(entries.aiIngestion, {
      name: `${root}/ai_ingestion.jsonl`,
    });
    archive.append(entries.attachmentsIndexJson, {
      name: `${root}/attachments_index.json`,
    });
    archive.append(entries.manifestJson, {
      name: `${root}/export_manifest.json`,
    });
    archive.append(processingLogJson, {
      name: `${root}/processing_log.json`,
    });
    archive.append(entries.errorsReportJson, {
      name: `${root}/errors_report.json`,
    });

    // Add downloaded attachment binaries under extracted_attachments/
    for (const att of attachmentBuffers) {
      archive.append(att.buffer, {
        name: `${root}/${att.storagePath}`,
      });
    }

    // Add OCR-rasterised page PNGs so users can audit exactly what was OCR'd.
    for (const img of ocrImages) {
      const pageStr = String(img.pageNumber).padStart(3, "0");
      archive.append(img.png, {
        name: `${root}/ocr_images/${img.messageId}/${img.attachmentId}/page_${pageStr}.png`,
      });
    }

    archive.finalize().catch((err) => reject(err));
  });
}

/**
 * Tee-write the streamed ZIP simultaneously to (a) the HTTP response, and
 * (b) two on-disk locations: `exports/export_<ts>/<filename>.zip` (immutable
 * timestamped copy) and `exports/latest/latest.zip` (always points at the
 * most recent export). Returns the absolute paths of both disk copies.
 *
 * Implementation notes:
 *   - We do NOT copy bytes after the response — we tee them at write-time
 *     using a PassThrough so an aborted client doesn't leave us with no
 *     persisted artifact.
 *   - The latest.zip copy is updated by writing a sibling file then
 *     atomically copying it; this avoids a partial-write window if the user
 *     downloads /api/gmail/export/latest mid-write.
 */
export interface DiskPersistOptions {
  exportsRoot: string;
  exportTimestamp: string; // safe-for-filesystem timestamp string
  zipFilename: string;
  /**
   * Export id propagated into the build_marker.json sidecar so operators
   * can correlate the persisted latest.zip with the export run that
   * produced it.
   */
  exportId: string;
}

export interface DiskPersistResult {
  timestampedPath: string;
  latestPath: string;
  /**
   * Absolute path to the build_marker.json sidecar written next to
   * latest.zip. Always populated after a successful tee — the
   * /api/gmail/export/latest endpoint refuses to serve latest.zip
   * unless this file exists and contains the current EXPORT_BUILD_MARKER.
   */
  buildMarkerPath: string;
}

export async function streamExportZipWithDiskTee(
  entries: SerializedBundleEntries,
  attachmentBuffers: AttachmentBufferEntry[],
  rootDirName: string,
  httpOut: Writable,
  ocrImages: OcrImageEntry[],
  disk: DiskPersistOptions,
): Promise<DiskPersistResult & { bytesWritten: number; entryCount: number }> {
  const tsDir = join(disk.exportsRoot, `export_${disk.exportTimestamp}`);
  const latestDir = join(disk.exportsRoot, "latest");
  await mkdir(tsDir, { recursive: true });
  await mkdir(latestDir, { recursive: true });
  const tsPath = join(tsDir, disk.zipFilename);
  const latestPath = join(latestDir, "latest.zip");

  // Tee the ZIP into both the HTTP response and the timestamped on-disk file.
  const tee = new PassThrough();
  const fileSink = createWriteStream(tsPath);
  tee.pipe(httpOut, { end: true });
  tee.pipe(fileSink, { end: true });

  // Wait for the file sink to finish so we can safely copy it to latest.zip
  // after the archive has been fully drained.
  const fileDone = new Promise<void>((resolve, reject) => {
    fileSink.on("finish", () => resolve());
    fileSink.on("error", (err) => reject(err));
  });

  const result = await streamExportZip(
    entries,
    attachmentBuffers,
    rootDirName,
    tee,
    ocrImages,
  );

  await fileDone;

  const buildMarkerPath = join(latestDir, BUILD_MARKER_SIDECAR_FILENAME);

  // Atomically publish latest.zip + build_marker.json.
  //
  // ORDERING (critical for correctness — closes a TOCTOU window where a
  // concurrent reader could observe a stale sidecar paired with a fresh
  // half-written zip, or vice versa):
  //
  //   1. Wipe any pre-existing sidecar so /latest immediately rejects
  //      reads while the new copy is in flight (better to 409 than to
  //      serve an inconsistent pair).
  //   2. Copy ts -> latest.tmp.zip (a sibling of latest.zip).
  //   3. Atomically rename latest.tmp.zip -> latest.zip. On POSIX,
  //      rename within the same dir is atomic; readers either see the
  //      old zip or the new zip, never a partial one.
  //   4. Write the sidecar via temp+rename so concurrent readers never
  //      observe a half-written JSON file.
  //
  // The whole sequence is best-effort: if any step throws we leave the
  // latest dir in a 409-rejecting state (no sidecar) rather than a
  // half-published one.
  try {
    if (!existsSync(dirname(latestPath))) {
      mkdirSync(dirname(latestPath), { recursive: true });
    }
    if (existsSync(buildMarkerPath)) {
      const { unlink } = await import("node:fs/promises");
      try {
        await unlink(buildMarkerPath);
      } catch (err) {
        // Only ENOENT is benign (the file disappeared between the
        // existsSync check and the unlink — fine, target state already
        // achieved). Any other error (EACCES, EBUSY, etc.) means we
        // CANNOT guarantee the rejecting-state invariant if a later
        // step then succeeds, so we propagate to the outer catch,
        // which leaves the publish unfinished and the latest dir in a
        // safe state.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") throw err;
      }
    }
    const tmpZip = `${latestPath}.tmp`;
    await copyFile(tsPath, tmpZip);
    await rename(tmpZip, latestPath);
    const sidecar: BuildMarkerSidecar = {
      build_marker: EXPORT_BUILD_MARKER,
      export_id: disk.exportId,
      created_at: new Date().toISOString(),
    };
    const tmpSidecar = `${buildMarkerPath}.tmp`;
    await writeFile(tmpSidecar, JSON.stringify(sidecar, null, 2), "utf8");
    await rename(tmpSidecar, buildMarkerPath);
  } catch {
    // swallow — caller can decide via the returned object
  }

  return {
    ...result,
    timestampedPath: tsPath,
    latestPath,
    buildMarkerPath,
  };
}
