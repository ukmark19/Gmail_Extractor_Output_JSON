import { spawn } from "child_process";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";

const execFile = promisify(execFileCb);

export interface DependencyStatus {
  available: boolean;
  version: string | null;
  /**
   * Absolute filesystem path to the resolved binary (via `which`),
   * or null if the binary cannot be located on PATH. Surfaced so
   * deployment-time logs make it obvious WHICH copy of the tool was
   * picked up (Nix store path vs system path vs missing).
   */
  path: string | null;
  error: string | null;
}

async function resolveBinaryPath(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("which", [cmd]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface DependencyReport {
  pdftoppm: DependencyStatus;
  pdftotext: DependencyStatus;
  pdfinfo: DependencyStatus;
  qpdf: DependencyStatus;
  tesseract: DependencyStatus;
  ocr_capable: boolean;
  pdf_security_capable: boolean;
  pdf_page_text_capable: boolean;
  checked_at: string;
}

let cachedReport: DependencyReport | null = null;

function check(cmd: string, versionArg: string): Promise<DependencyStatus> {
  return new Promise((resolve) => {
    const finish = async (partial: Omit<DependencyStatus, "path">) => {
      const path = partial.available ? await resolveBinaryPath(cmd) : null;
      resolve({ ...partial, path });
    };
    try {
      const child = spawn(cmd, [versionArg]);
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("error", (e) =>
        void finish({ available: false, version: null, error: e.message }),
      );
      child.on("close", (code) => {
        const text = (out + "\n" + err).trim();
        const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
        const version = m ? m[1] : null;
        // Most tools exit 0; tesseract --version exits 0; qpdf --version exits 0; pdftoppm -v exits 99.
        // Treat any case where we got a version string as available.
        if (version) {
          void finish({ available: true, version, error: null });
        } else if (code === 0) {
          void finish({ available: true, version: null, error: null });
        } else {
          void finish({
            available: false,
            version: null,
            error: text.slice(0, 200) || `exit ${code}`,
          });
        }
      });
    } catch (e) {
      void finish({
        available: false,
        version: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

export async function checkDependencies(): Promise<DependencyReport> {
  const [pdftoppm, pdftotext, pdfinfo, qpdf, tesseract] = await Promise.all([
    check("pdftoppm", "-v"),
    check("pdftotext", "-v"),
    check("pdfinfo", "-v"),
    check("qpdf", "--version"),
    check("tesseract", "--version"),
  ]);
  const report: DependencyReport = {
    pdftoppm,
    pdftotext,
    pdfinfo,
    qpdf,
    tesseract,
    ocr_capable: pdftoppm.available,
    pdf_security_capable: qpdf.available,
    pdf_page_text_capable: pdftotext.available,
    checked_at: new Date().toISOString(),
  };
  cachedReport = report;
  return report;
}

export function getDependencyReport(): DependencyReport | null {
  return cachedReport;
}

// Avoid two callers kicking off duplicate concurrent probes.
let pendingProbe: Promise<DependencyReport> | null = null;

/**
 * Always returns a populated DependencyReport. If the startup probe hasn't
 * finished yet, this awaits it (or runs one) instead of returning null.
 *
 * The original `getDependencyReport()` was returning `null` when the
 * extractor consulted it before the fire-and-forget startup probe in
 * `index.ts` had resolved. Downstream code does
 * `if (!deps?.pdftoppm.available)` so a null report is misreported as
 * "pdftoppm/poppler-utils missing on server" — even when the binaries are
 * actually installed and working. Use this helper everywhere on hot paths.
 */
export async function ensureDependencyReport(): Promise<DependencyReport> {
  if (cachedReport) return cachedReport;
  if (pendingProbe) return pendingProbe;
  pendingProbe = checkDependencies().finally(() => {
    pendingProbe = null;
  });
  return pendingProbe;
}

export function logDependencyReport(report: DependencyReport): void {
  // Render `ok (version) @ path` so deployment-time logs show both
  // the version string and the resolved binary path. This is the
  // single line operators inspect when triaging
  // "pdftoppm/poppler-utils missing on server"-style failures.
  const fmt = (label: string, s: DependencyStatus, missingMsg?: string) =>
    s.available
      ? `ok (${s.version ?? "unknown"})${s.path ? " @ " + s.path : ""}`
      : missingMsg ?? `MISSING: ${s.error}`;
  console.log("[deps.report]", {
    pdftoppm: fmt("pdftoppm", report.pdftoppm),
    pdftotext: fmt("pdftotext", report.pdftotext),
    pdfinfo: fmt("pdfinfo", report.pdfinfo),
    qpdf: fmt("qpdf", report.qpdf),
    tesseract: fmt(
      "tesseract",
      report.tesseract,
      "bundled-js (system tesseract not used)",
    ),
    ocr_capable: report.ocr_capable,
    pdf_security_capable: report.pdf_security_capable,
    pdf_page_text_capable: report.pdf_page_text_capable,
  });
  if (!report.pdftoppm.available) {
    console.warn(
      "[deps.warning] pdftoppm missing — OCR fallback for scanned PDFs will fail with environment_error/ocr_unavailable.",
    );
  }
  if (!report.qpdf.available) {
    console.warn(
      "[deps.warning] qpdf missing — encrypted/permission-restricted PDFs cannot be unlocked automatically.",
    );
  }
}
