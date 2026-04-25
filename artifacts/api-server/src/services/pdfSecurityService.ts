import { spawn } from "child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export type UnlockFailureCategory =
  | "encrypted_or_password_protected"
  | "corrupt_or_malformed"
  | "parser_error"
  | "unknown_error";

export interface PdfSecurityAnalysis {
  is_encrypted: boolean;
  requires_password: boolean;
  permissions: {
    print: boolean | null;
    modify: boolean | null;
    extract: boolean | null;
    annotate: boolean | null;
    fill_forms: boolean | null;
    accessibility: boolean | null;
    assemble: boolean | null;
    print_high_res: boolean | null;
  };
  encryption_method: string | null;
  page_count: number | null;
  raw: {
    pdfinfo_ok: boolean;
    qpdf_show_encryption: string | null;
  };
}

export interface UnlockResult {
  success: boolean;
  output_path: string | null;
  error: string | null;
  failure_category: UnlockFailureCategory | null;
  permissions_were_restricted: boolean;
}

export interface ImageConversionResult {
  success: boolean;
  image_paths: string[];
  output_dir: string | null;
  error: string | null;
}

interface CommandResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

async function runCommand(
  cmd: string,
  args: string[],
  opts: { input?: Buffer; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        code: code ?? -1,
      });
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function parsePermissions(
  qpdfShow: string,
): PdfSecurityAnalysis["permissions"] {
  const has = (label: string, allowed: string): boolean | null => {
    const re = new RegExp(`${label}:\\s*(allowed|not allowed)`, "i");
    const m = qpdfShow.match(re);
    if (!m) return null;
    return m[1].toLowerCase() === allowed;
  };
  return {
    print: has("Print", "allowed"),
    modify: has("Modify", "allowed"),
    extract: has("Extract", "allowed"),
    annotate: has("Annotate", "allowed"),
    fill_forms: has("Fill form", "allowed"),
    accessibility: has("Accessibility", "allowed"),
    assemble: has("Assemble", "allowed"),
    print_high_res: has("Print high resolution", "allowed"),
  };
}

/**
 * Inspect a PDF buffer for encryption, password requirements, and permission flags.
 * Combines a byte-level marker scan with `pdfinfo` and `qpdf --show-encryption`.
 */
export async function analyzePdfSecurity(
  fileBuffer: Buffer,
): Promise<PdfSecurityAnalysis> {
  // Byte-level encryption marker
  const head = fileBuffer
    .subarray(0, Math.min(fileBuffer.length, 4096))
    .toString("latin1");
  const tail = fileBuffer
    .subarray(Math.max(0, fileBuffer.length - 4096))
    .toString("latin1");
  const markerEncrypted = /\/Encrypt\s/.test(head) || /\/Encrypt\s/.test(tail);

  // pdfinfo for page count and corroboration
  let pageCount: number | null = null;
  let pdfinfoOk = false;
  try {
    const { stdout, code } = await runCommand("pdfinfo", ["-"], {
      input: fileBuffer,
      timeoutMs: 15_000,
    });
    pdfinfoOk = code === 0;
    if (pdfinfoOk) {
      const m = stdout.toString("utf8").match(/^Pages:\s+(\d+)/m);
      if (m) pageCount = parseInt(m[1], 10);
    }
  } catch {
    /* ignore */
  }

  // qpdf --show-encryption: definitive encryption details
  let qpdfShow: string | null = null;
  let requiresPassword = false;
  let encryptionMethod: string | null = null;
  let permissions = parsePermissions("");
  try {
    // Write to temp file because --show-encryption needs a file path
    const tmpDir = await mkdtemp(join(tmpdir(), "pdf-sec-analyze-"));
    try {
      const tmpPath = join(tmpDir, "in.pdf");
      await writeFile(tmpPath, fileBuffer);
      const { stdout, stderr, code } = await runCommand(
        "qpdf",
        ["--show-encryption", tmpPath],
        { timeoutMs: 15_000 },
      );
      qpdfShow = (stdout.toString("utf8") + "\n" + stderr).trim();
      // qpdf prints "File is not encrypted" or full encryption block.
      // Exit code is 0 for not-encrypted, 0 also when encryption shown without password.
      if (/invalid password/i.test(qpdfShow) || code === 2) {
        requiresPassword = true;
      }
      const methodMatch = qpdfShow.match(/method:\s*(\S+)/i);
      if (methodMatch) encryptionMethod = methodMatch[1];
      permissions = parsePermissions(qpdfShow);
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    /* ignore */
  }

  return {
    is_encrypted: markerEncrypted,
    requires_password: requiresPassword,
    permissions,
    encryption_method: encryptionMethod,
    page_count: pageCount,
    raw: {
      pdfinfo_ok: pdfinfoOk,
      qpdf_show_encryption: qpdfShow,
    },
  };
}

/**
 * Attempt to remove security restrictions on a PDF using qpdf
 * (the same engine that pikepdf wraps).
 *
 * This succeeds for PDFs whose owner password is empty (the typical case for
 * "no-copy"/"no-print" bank statements and invoices). It will NOT decrypt PDFs
 * that have a real user password — those return failure_category =
 * "encrypted_or_password_protected".
 *
 * If `password` is supplied, qpdf will use it to open the document.
 */
export async function attemptPdfUnlock(
  inputPath: string,
  outputPath: string,
  options: { password?: string } = {},
): Promise<UnlockResult> {
  // First, inspect to know whether anything was restricted at all.
  let permissionsWereRestricted = false;
  try {
    const buf = await readFile(inputPath);
    const analysis = await analyzePdfSecurity(buf);
    const p = analysis.permissions;
    permissionsWereRestricted = Object.values(p).some((v) => v === false);
  } catch {
    /* non-fatal */
  }

  const args: string[] = [];
  if (options.password) {
    args.push(`--password=${options.password}`);
  }
  args.push("--decrypt", inputPath, outputPath);

  try {
    const { stderr, code } = await runCommand("qpdf", args, {
      timeoutMs: 30_000,
    });
    if (code === 0 || code === 3) {
      // 0 = success, 3 = success with warnings (acceptable for our purposes)
      return {
        success: true,
        output_path: outputPath,
        error: null,
        failure_category: null,
        permissions_were_restricted: permissionsWereRestricted,
      };
    }
    const lowered = stderr.toLowerCase();
    let category: UnlockFailureCategory = "unknown_error";
    if (
      lowered.includes("invalid password") ||
      lowered.includes("password required") ||
      lowered.includes("encrypted")
    ) {
      category = "encrypted_or_password_protected";
    } else if (
      lowered.includes("not a pdf") ||
      lowered.includes("damaged") ||
      lowered.includes("can't find") ||
      lowered.includes("trailer")
    ) {
      category = "corrupt_or_malformed";
    } else {
      category = "parser_error";
    }
    return {
      success: false,
      output_path: null,
      error: stderr.trim() || `qpdf exited with code ${code}`,
      failure_category: category,
      permissions_were_restricted: permissionsWereRestricted,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output_path: null,
      error: msg,
      failure_category: "unknown_error",
      permissions_were_restricted: permissionsWereRestricted,
    };
  }
}

/**
 * Convert PDF pages to PNG images via pdftoppm (poppler).
 * Returns absolute paths to images in page order. Caller owns cleanup of `output_dir`.
 */
export async function convertPdfToImages(
  pdfPath: string,
  options: { dpi?: number; maxPages?: number } = {},
): Promise<ImageConversionResult> {
  const dpi = options.dpi ?? 200;
  const dir = await mkdtemp(join(tmpdir(), "pdf-img-"));
  try {
    const args = ["-r", String(dpi)];
    if (options.maxPages) {
      args.push("-f", "1", "-l", String(options.maxPages));
    }
    args.push("-png", pdfPath, join(dir, "page"));
    const { code, stderr } = await runCommand("pdftoppm", args, {
      timeoutMs: 120_000,
    });
    if (code !== 0) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return {
        success: false,
        image_paths: [],
        output_dir: null,
        error: stderr.trim() || `pdftoppm exited ${code}`,
      };
    }
    const files = (await readdir(dir))
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort()
      .map((f) => join(dir, f));
    return {
      success: true,
      image_paths: files,
      output_dir: dir,
      error: null,
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      success: false,
      image_paths: [],
      output_dir: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Map an unlock failure category and password-required flag to a user-facing action message.
 */
export function userActionForUnlock(
  analysis: PdfSecurityAnalysis,
  unlock: UnlockResult,
  finalStatus: "success" | "partial" | "failed",
): string | null {
  if (finalStatus === "success" && unlock.permissions_were_restricted) {
    return "PDF had usage restrictions which were removed successfully.";
  }
  if (finalStatus === "success") return null;
  if (
    unlock.failure_category === "encrypted_or_password_protected" ||
    analysis.requires_password
  ) {
    return "PDF is password protected. Provide password or remove security manually.";
  }
  if (unlock.failure_category === "corrupt_or_malformed") {
    return "PDF is malformed or corrupted. Re-save or regenerate the file.";
  }
  if (unlock.failure_category === "parser_error") {
    return "PDF could not be parsed. Verify the file opens in a standard PDF reader.";
  }
  return "PDF could not be processed. See errors for details.";
}
