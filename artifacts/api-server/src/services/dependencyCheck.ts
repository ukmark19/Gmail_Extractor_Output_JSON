import { spawn } from "child_process";

export interface DependencyStatus {
  available: boolean;
  version: string | null;
  error: string | null;
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
    try {
      const child = spawn(cmd, [versionArg]);
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("error", (e) =>
        resolve({ available: false, version: null, error: e.message }),
      );
      child.on("close", (code) => {
        const text = (out + "\n" + err).trim();
        const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
        const version = m ? m[1] : null;
        // Most tools exit 0; tesseract --version exits 0; qpdf --version exits 0; pdftoppm -v exits 99.
        // Treat any case where we got a version string as available.
        if (version) {
          resolve({ available: true, version, error: null });
        } else if (code === 0) {
          resolve({ available: true, version: null, error: null });
        } else {
          resolve({
            available: false,
            version: null,
            error: text.slice(0, 200) || `exit ${code}`,
          });
        }
      });
    } catch (e) {
      resolve({
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
// Capability test: Codex can edit and publish this repository.
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
  console.log("[deps.report]", {
    pdftoppm: report.pdftoppm.available
      ? `ok (${report.pdftoppm.version ?? "unknown"})`
      : `MISSING: ${report.pdftoppm.error}`,
    pdftotext: report.pdftotext.available
      ? `ok (${report.pdftotext.version ?? "unknown"})`
      : `MISSING: ${report.pdftotext.error}`,
    pdfinfo: report.pdfinfo.available
      ? `ok (${report.pdfinfo.version ?? "unknown"})`
      : `MISSING: ${report.pdfinfo.error}`,
    qpdf: report.qpdf.available
      ? `ok (${report.qpdf.version ?? "unknown"})`
      : `MISSING: ${report.qpdf.error}`,
    tesseract: report.tesseract.available
      ? `ok (${report.tesseract.version ?? "unknown"})`
      : `bundled-js (system tesseract not used)`,
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
