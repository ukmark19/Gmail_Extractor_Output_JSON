import { gmail_v1 } from "googleapis";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "./logger";
import { decodeBase64 } from "./gmail";
import {
  analyzePdfSecurity,
  attemptPdfUnlock,
  convertPdfToImages,
  type PdfSecurityAnalysis,
} from "../services/pdfSecurityService";
import { getDependencyReport } from "../services/dependencyCheck";

const OCR_MAX_PAGES = 20;
const OCR_TRIGGER_CHAR_THRESHOLD = 50;
const OCR_ENABLED_DEFAULT = true;

function isOcrEnabled(): boolean {
  const v = process.env.OCR_ENABLED;
  if (v === undefined || v === "") return OCR_ENABLED_DEFAULT;
  return v.toLowerCase() === "true" || v === "1";
}

async function parsePdfBuffer(
  buffer: Buffer,
): Promise<{ text: string; numpages: number }> {
  const pdfParseModule: unknown = await import("pdf-parse/lib/pdf-parse.js");
  const moduleCandidate = pdfParseModule as {
    default?: unknown;
    pdfParse?: unknown;
  };
  const pdfParseRaw =
    typeof moduleCandidate === "function"
      ? moduleCandidate
      : typeof moduleCandidate.default === "function"
        ? moduleCandidate.default
        : typeof (moduleCandidate.default as { default?: unknown })?.default ===
            "function"
          ? (moduleCandidate.default as { default: unknown }).default
          : typeof moduleCandidate.pdfParse === "function"
            ? moduleCandidate.pdfParse
            : null;
  if (typeof pdfParseRaw !== "function") {
    throw new Error(
      `pdf-parse export is not callable (got ${typeof pdfParseRaw})`,
    );
  }
  const pdfParse = pdfParseRaw as (
    data: Buffer,
    opts?: Record<string, unknown>,
  ) => Promise<{ text: string; numpages: number }>;
  return pdfParse(buffer);
}

async function runCommand(
  cmd: string,
  args: string[],
  opts: { input?: Buffer; timeoutMs?: number } = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
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
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code: code ?? -1 });
    });
    if (opts.input) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

async function getPdfPageCount(buffer: Buffer): Promise<number | null> {
  try {
    const { stdout, code } = await runCommand("pdfinfo", ["-"], {
      input: buffer,
      timeoutMs: 15_000,
    });
    if (code === 0) {
      const match = stdout.toString("utf8").match(/^Pages:\s+(\d+)/m);
      if (match) return parseInt(match[1], 10);
    }
  } catch {
    /* fall through */
  }
  try {
    const text = buffer.toString("latin1");
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    if (matches && matches.length > 0) return matches.length;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Extract per-page text using pdftotext (poppler).
 * Returns one entry per page with text + extraction status.
 */
async function extractPdfPages(
  buffer: Buffer,
  knownPageCount: number | null,
): Promise<{ pages: PageRecord[]; method: "pdftotext" | "pdf_parse_split"; error: string | null }> {
  const pageCount = knownPageCount ?? (await getPdfPageCount(buffer));
  if (!pageCount || pageCount <= 0) {
    return { pages: [], method: "pdftotext", error: "page count unknown" };
  }
  const deps = getDependencyReport();
  // Prefer pdftotext per-page when available
  if (deps?.pdftotext.available) {
    const tmp = await mkdtemp(join(tmpdir(), "pdf-pages-"));
    try {
      const inPath = join(tmp, "in.pdf");
      await writeFile(inPath, buffer);
      const pages: PageRecord[] = [];
      for (let p = 1; p <= pageCount; p++) {
        try {
          const { stdout, code, stderr } = await runCommand(
            "pdftotext",
            ["-layout", "-f", String(p), "-l", String(p), inPath, "-"],
            { timeoutMs: 30_000 },
          );
          if (code === 0) {
            const text = stdout.toString("utf8").replace(/\f/g, "").trim();
            pages.push({
              page_number: p,
              text,
              text_extracted: text.length > 0,
              extraction_method: text.length > 0 ? "pdf_text" : "none",
              error: text.length === 0 ? "empty page output" : null,
            });
          } else {
            pages.push({
              page_number: p,
              text: "",
              text_extracted: false,
              extraction_method: "none",
              error: stderr.trim().slice(0, 200) || `pdftotext exit ${code}`,
            });
          }
        } catch (err) {
          pages.push({
            page_number: p,
            text: "",
            text_extracted: false,
            extraction_method: "none",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { pages, method: "pdftotext", error: null };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  // Fallback: parse whole PDF, fabricate single page entry per real page with no per-page split
  try {
    const r = await parsePdfBuffer(buffer);
    const text = r.text || "";
    const pages: PageRecord[] = [];
    for (let p = 1; p <= pageCount; p++) {
      pages.push({
        page_number: p,
        text: p === 1 ? text : "",
        text_extracted: p === 1 && text.length > 0,
        extraction_method: p === 1 && text.length > 0 ? "pdf_text" : "none",
        error: null,
      });
    }
    return { pages, method: "pdf_parse_split", error: null };
  } catch (err) {
    return {
      pages: [],
      method: "pdf_parse_split",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ocrPdfPages(
  buffer: Buffer,
  meta: { messageId: string; attachmentId: string; filename: string },
): Promise<{
  pages: PageRecord[];
  pagesProcessed: number;
  pagesTotal: number | null;
  error: string | null;
  pageImages: Array<{ pageNumber: number; png: Buffer }>;
}> {
  const deps = getDependencyReport();
  if (!deps?.pdftoppm.available) {
    return {
      pages: [],
      pagesProcessed: 0,
      pagesTotal: null,
      error: "pdftoppm (poppler-utils) not installed — cannot rasterize for OCR",
      pageImages: [],
    };
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "pdf-ocr-"));
  try {
    const pdfPath = join(tmpDir, "input.pdf");
    await writeFile(pdfPath, buffer);
    const pageCount = await getPdfPageCount(buffer);
    const pagesToProcess = pageCount
      ? Math.min(pageCount, OCR_MAX_PAGES)
      : OCR_MAX_PAGES;
    console.log("[pdf.ocr.rasterize.started]", {
      ...meta,
      pagesToProcess,
      pagesTotal: pageCount,
    });
    const { code, stderr } = await runCommand(
      "pdftoppm",
      [
        "-r",
        "200",
        "-f",
        "1",
        "-l",
        String(pagesToProcess),
        "-png",
        pdfPath,
        join(tmpDir, "page"),
      ],
      { timeoutMs: 120_000 },
    );
    if (code !== 0) {
      throw new Error(`pdftoppm exited ${code}: ${stderr.slice(0, 500)}`);
    }
    const files = (await readdir(tmpDir))
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort();
    const tesseractMod = await import("tesseract.js");
    const recognize = (
      tesseractMod as unknown as {
        recognize: (
          img: Buffer,
          lang: string,
          options?: Record<string, unknown>,
        ) => Promise<{ data: { text: string } }>;
      }
    ).recognize;

    const pages: PageRecord[] = [];
    const pageImages: Array<{ pageNumber: number; png: Buffer }> = [];
    for (let i = 0; i < files.length; i++) {
      const pngPath = join(tmpDir, files[i]);
      const pngBuf = await readFile(pngPath);
      // Surface the rasterised page so the route can include it under
      // ocr_images/<msg>/<att>/page_<n>.png in the export ZIP.
      pageImages.push({ pageNumber: i + 1, png: pngBuf });
      try {
        const result = await recognize(pngBuf, "eng");
        const pageText = (result.data.text || "").trim();
        pages.push({
          page_number: i + 1,
          text: pageText,
          text_extracted: pageText.length > 0,
          extraction_method: pageText.length > 0 ? "ocr" : "none",
          error: pageText.length === 0 ? "OCR returned empty" : null,
        });
      } catch (err) {
        pages.push({
          page_number: i + 1,
          text: "",
          text_extracted: false,
          extraction_method: "none",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Pad un-OCR'd pages (over the cap) with placeholder records
    if (pageCount && pageCount > files.length) {
      for (let p = files.length + 1; p <= pageCount; p++) {
        pages.push({
          page_number: p,
          text: "",
          text_extracted: false,
          extraction_method: "none",
          error: `skipped: page ${p} exceeds OCR_MAX_PAGES=${OCR_MAX_PAGES}`,
        });
      }
    }
    return {
      pages,
      pagesProcessed: files.length,
      pagesTotal: pageCount,
      error: null,
      pageImages,
    };
  } catch (err) {
    return {
      pages: [],
      pagesProcessed: 0,
      pagesTotal: null,
      error: err instanceof Error ? err.message : String(err),
      pageImages: [],
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "unnamed";
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export type FailureCategory =
  | "unsupported_file_type"
  | "encrypted_or_password_protected"
  | "corrupt_or_malformed"
  | "empty_file"
  | "too_large"
  | "extraction_timeout"
  | "parser_error"
  | "ocr_failed"
  // ocr_not_configured is emitted when OCR is required but disabled
  // or when the system OCR pipeline (pdftoppm) is unavailable.
  | "ocr_not_configured"
  | "environment_error"
  | "network_fetch_error"
  | "permission_error"
  | "unknown_error";

export type ExtractionStatus =
  | "success"
  | "partial"
  | "failed"
  | "unsupported"
  | "skipped";

export type ExtractionMethod =
  | "pdf_parser"
  | "pdf_parser+ocr"
  | "ocr"
  | "docx_parser"
  | "xlsx_parser"
  | "csv_parser"
  | "json_parser"
  | "xml_parser"
  | "html_to_text"
  | "plain_text"
  | "eml_parser"
  | "image_metadata"
  | "none";

export type AttachmentRole =
  | "inline_signature"
  | "embedded_logo"
  | "substantive_attachment"
  | "child_email"
  | "unknown_image"
  | "document"
  | "unknown";

export interface PageRecord {
  page_number: number;
  text: string;
  text_extracted: boolean;
  extraction_method: "pdf_text" | "ocr" | "none";
  error: string | null;
}

export interface ChildEmailRecord {
  document_id: string;
  parent_attachment_id: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  attachment_count: number;
}

export interface AttachmentExtractionResult {
  attachment_id: string;
  message_id: string;
  parent_document_id: string;
  part_id: string;
  filename: string;
  safe_filename: string;
  storage_path: string;
  sha256: string | null;
  original_sha256: string | null;
  processed_sha256: string | null;
  mime_type: string;
  file_extension: string;
  size_bytes: number;
  content_id: string;
  is_inline: boolean;
  is_embedded: boolean;
  is_supported: boolean;
  was_downloaded: boolean;
  attachment_role: AttachmentRole;
  image_dimensions: { width: number; height: number } | null;
  extraction_status: ExtractionStatus;
  skip_reason: string | null;
  failure_category: FailureCategory | null;
  failure_detail: string | null;
  user_action_needed: string | null;
  extraction_method: ExtractionMethod;
  text_extracted: boolean;
  text_quality: "high" | "medium" | "low" | "unknown";
  // PDF security pipeline
  is_encrypted: boolean | null;
  unlock_attempted: boolean;
  unlock_status: "success" | "failed" | null;
  unlock_error: string | null;
  security_removed: boolean;
  security_removal_method: "qpdf" | "none" | "failed";
  security_removal_error: string | null;
  fallback_used: boolean;
  fallback_method: "pdf_to_images" | "ocr" | null;
  // PDF page-level
  pages: PageRecord[] | null;
  pages_extracted_count: number | null;
  pages_failed_count: number | null;
  contains_structured_data: boolean;
  structured_data_type: "table" | "spreadsheet" | "json" | "xml" | "none";
  page_count: number | null;
  sheet_names: string[] | null;
  extracted_text: string | null;
  structured_data: Record<string, unknown> | null;
  // EML
  child_emails: ChildEmailRecord[] | null;
  // Deduplication: when this attachment's bytes are byte-identical (same
  // sha256) to an earlier attachment in the same export, this points at the
  // first attachment's storage_path. The buffer is NOT re-stored.
  duplicate_of: string | null;
  warnings: string[];
  errors: string[];
}

export interface ProcessingLogEntry {
  timestamp: string;
  message_id: string;
  attachment_id: string | null;
  filename: string | null;
  event_type: string;
  status: string;
  extraction_method: ExtractionMethod | null;
  duration_ms: number | null;
  error_category: FailureCategory | null;
  error_message: string | null;
  user_action_needed: string | null;
}

export interface ExtractedAttachment {
  result: AttachmentExtractionResult;
  /** raw downloaded bytes — null if download failed */
  buffer: Buffer | null;
  /** processed (e.g. qpdf-decrypted) bytes — only set when security_removed=true */
  processedBuffer: Buffer | null;
  /**
   * PNG buffers of pages rasterised for OCR. Surfaced into the ZIP under
   * ocr_images/<messageId>/<attachmentId>/page_<n>.png so users can audit
   * exactly what was OCR'd. Null when no rasterisation occurred.
   */
  ocrPageImages?: Array<{ pageNumber: number; png: Buffer }> | null;
}

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB

const SUPPORTED_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/html",
  "application/json",
  "application/xml",
  "text/xml",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "message/rfc822",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/webp",
  "image/svg+xml",
]);

function getFileExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  return dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : "";
}

function makeLogEntry(
  messageId: string,
  attachmentId: string | null,
  filename: string | null,
  eventType: string,
  status: string,
  startTime: number,
  extras: Partial<ProcessingLogEntry> = {},
): ProcessingLogEntry {
  return {
    timestamp: new Date().toISOString(),
    message_id: messageId,
    attachment_id: attachmentId,
    filename,
    event_type: eventType,
    status,
    extraction_method: null,
    duration_ms: Date.now() - startTime,
    error_category: null,
    error_message: null,
    user_action_needed: null,
    ...extras,
  };
}

function classifyImage(opts: {
  mimeType: string;
  size: number;
  isInline: boolean;
  contentId: string;
  filename: string;
}): AttachmentRole {
  const lowerName = opts.filename.toLowerCase();
  if (
    opts.isInline &&
    opts.size < 50_000 &&
    /sig|signature/i.test(opts.filename)
  ) {
    return "inline_signature";
  }
  if (
    opts.isInline &&
    opts.contentId &&
    (lowerName.includes("logo") || opts.size < 30_000)
  ) {
    return "embedded_logo";
  }
  if (opts.size >= 200_000 && !opts.isInline) {
    return "substantive_attachment";
  }
  return "unknown_image";
}

function extractTextFromCsv(text: string): {
  extracted: string;
  structured: Record<string, unknown>;
} {
  const lines = text.trim().split("\n");
  const headers =
    lines[0]?.split(",").map((h) => h.trim().replace(/^"|"$/g, "")) || [];
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? "";
    });
    rows.push(row);
  }
  return {
    extracted: text,
    structured: {
      headers,
      row_count: rows.length,
      sample_rows: rows.slice(0, 5),
    },
  };
}

function buildPagedExtractedText(pages: PageRecord[]): string {
  const out: string[] = [];
  for (const p of pages) {
    if (!p.text || p.text.length === 0) continue;
    out.push(`--- Page ${p.page_number} ---`);
    out.push(p.text);
    out.push("");
  }
  return out.join("\n").trim();
}

interface ResultDefaults {
  attachmentId: string;
  messageId: string;
  parentDocumentId: string;
  partId: string;
  filename: string;
  safeFilename: string;
  storagePath: string;
  mimeType: string;
  fileExtension: string;
  sizeBytes: number;
  contentId: string;
  isInline: boolean;
}

function makeBaseResult(
  d: ResultDefaults,
): Omit<
  AttachmentExtractionResult,
  | "is_supported"
  | "was_downloaded"
  | "extraction_status"
  | "skip_reason"
  | "failure_category"
  | "failure_detail"
  | "user_action_needed"
  | "extraction_method"
  | "text_extracted"
  | "text_quality"
  | "extracted_text"
  | "structured_data"
  | "contains_structured_data"
  | "structured_data_type"
  | "page_count"
  | "sheet_names"
> {
  return {
    attachment_id: d.attachmentId,
    message_id: d.messageId,
    parent_document_id: d.parentDocumentId,
    part_id: d.partId,
    filename: d.filename,
    safe_filename: d.safeFilename,
    storage_path: d.storagePath,
    sha256: null,
    original_sha256: null,
    processed_sha256: null,
    mime_type: d.mimeType,
    file_extension: d.fileExtension,
    size_bytes: d.sizeBytes,
    content_id: d.contentId,
    is_inline: d.isInline,
    is_embedded: d.isInline && !!d.contentId,
    attachment_role: "unknown",
    image_dimensions: null,
    is_encrypted: null,
    unlock_attempted: false,
    unlock_status: null,
    unlock_error: null,
    security_removed: false,
    security_removal_method: "none",
    security_removal_error: null,
    fallback_used: false,
    fallback_method: null,
    pages: null,
    pages_extracted_count: null,
    pages_failed_count: null,
    child_emails: null,
    duplicate_of: null,
    warnings: [],
    errors: [],
  };
}

export async function extractAttachmentContent(
  gmailClient: gmail_v1.Gmail,
  messageId: string,
  part: {
    partId?: string | null;
    mimeType?: string | null;
    filename?: string | null;
    body?: {
      attachmentId?: string | null;
      size?: number | null;
      data?: string | null;
    } | null;
    headers?: { name?: string | null; value?: string | null }[] | null;
  },
  processingLog: ProcessingLogEntry[],
): Promise<ExtractedAttachment> {
  const startTime = Date.now();
  const filename = part.filename || "unnamed";
  const mimeType = part.mimeType || "application/octet-stream";
  const attachmentId = part.body?.attachmentId || "";
  const sizeBytes = part.body?.size || 0;
  const partId = part.partId || "";
  const fileExtension = getFileExtension(filename);
  const contentIdHeader = (part.headers || []).find(
    (h) => h.name?.toLowerCase() === "content-id",
  );
  const contentId = contentIdHeader?.value?.replace(/[<>]/g, "") || "";
  const isInline = !!(part.headers || []).find(
    (h) =>
      h.name?.toLowerCase() === "content-disposition" &&
      h.value?.includes("inline"),
  );

  const safeFilename = sanitizeFilename(filename);
  const parentDocumentId = `gmail_${messageId}`;
  // Storage path is finalised by the caller after sha256 is known,
  // but we set a sensible default here so the result is internally valid.
  const storagePath = `extracted_attachments/${messageId}/${safeFilename}`;

  const defaults: ResultDefaults = {
    attachmentId,
    messageId,
    parentDocumentId,
    partId,
    filename,
    safeFilename,
    storagePath,
    mimeType,
    fileExtension,
    sizeBytes,
    contentId,
    isInline,
  };

  const base = makeBaseResult(defaults);

  // Size check (still allow downloads up to 25MB)
  if (sizeBytes > MAX_ATTACHMENT_SIZE) {
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_extraction_failed",
        "skipped",
        startTime,
        {
          error_category: "too_large",
          error_message: `Attachment size ${sizeBytes} exceeds limit of ${MAX_ATTACHMENT_SIZE}`,
          user_action_needed:
            "Attachment exceeds the 25 MB size cap and was skipped. Process it externally.",
        },
      ),
    );
    return {
      result: {
        ...base,
        is_supported: false,
        was_downloaded: false,
        extraction_status: "skipped",
        skip_reason: `File size ${(sizeBytes / 1024 / 1024).toFixed(1)} MB exceeds the 25 MB limit`,
        failure_category: "too_large",
        failure_detail: `Attachment is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB, limit is 25 MB`,
        user_action_needed:
          "Attachment exceeded configured size limit and was skipped.",
        extraction_method: "none",
        text_extracted: false,
        text_quality: "unknown",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: null,
        structured_data: null,
      },
      buffer: null,
      processedBuffer: null,
    };
  }

  // No attachment ID — try body.data fallback (small inline parts often
  // arrive with bytes embedded directly in the part rather than a separate
  // attachmentId). Only fail when neither source is available.
  const inlineData = part.body?.data || null;
  if (!attachmentId && !inlineData) {
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_download_completed",
        "failed",
        startTime,
        {
          error_category: "network_fetch_error",
          error_message:
            "No Gmail attachment ID and no inline body.data available",
        },
      ),
    );
    return {
      result: {
        ...base,
        is_supported: SUPPORTED_MIME_TYPES.has(mimeType),
        was_downloaded: false,
        extraction_status: "failed",
        skip_reason: null,
        failure_category: "network_fetch_error",
        failure_detail:
          "No Gmail attachment ID or inline body.data available to download this attachment",
        user_action_needed:
          "Open the source email in Gmail; some inline content has no separately addressable attachment.",
        extraction_method: "none",
        text_extracted: false,
        text_quality: "unknown",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: null,
        structured_data: null,
      },
      buffer: null,
      processedBuffer: null,
    };
  }

  // Download
  processingLog.push(
    makeLogEntry(
      messageId,
      attachmentId,
      filename,
      "attachment_download_started",
      "pending",
      startTime,
    ),
  );

  let attachmentData: Buffer;
  try {
    let rawData: string | null | undefined;
    if (attachmentId) {
      const attResponse = await gmailClient.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });
      rawData = attResponse.data.data;
    } else {
      // Fallback to inline body.data (already base64url-encoded by Gmail).
      rawData = inlineData;
    }
    if (!rawData || rawData.length === 0) {
      throw new Error("Empty attachment data received from Gmail API");
    }
    // Normalise base64url → base64 (Gmail returns base64url) and decode.
    const b64 = rawData.replace(/-/g, "+").replace(/_/g, "/");
    attachmentData = Buffer.from(b64, "base64");
    if (attachmentData.length === 0) {
      throw new Error(
        "Attachment data decoded to zero bytes (malformed base64)",
      );
    }
    base.sha256 = sha256Hex(attachmentData);
    base.original_sha256 = base.sha256;
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_download_completed",
        "success",
        startTime,
      ),
    );
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_hash_generated",
        "success",
        startTime,
      ),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_download_completed",
        "failed",
        startTime,
        {
          error_category: "network_fetch_error",
          error_message: errMsg,
        },
      ),
    );
    return {
      result: {
        ...base,
        is_supported: SUPPORTED_MIME_TYPES.has(mimeType),
        was_downloaded: false,
        extraction_status: "failed",
        skip_reason: null,
        failure_category: "network_fetch_error",
        failure_detail: `Failed to download attachment from Gmail: ${errMsg}`,
        user_action_needed:
          "Retry the export. If the error persists, the attachment may have been deleted on Gmail's side.",
        extraction_method: "none",
        text_extracted: false,
        text_quality: "unknown",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: null,
        structured_data: null,
      },
      buffer: null,
      processedBuffer: null,
    };
  }

  // ============================================================
  // Image: download + classify; do not OCR by default
  // ============================================================
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    const role = classifyImage({
      mimeType,
      size: attachmentData.length,
      isInline,
      contentId,
      filename,
    });
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_extraction_completed",
        "success",
        startTime,
        { extraction_method: "image_metadata" },
      ),
    );
    return {
      result: {
        ...base,
        attachment_role: role,
        is_supported: false,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason:
          "Image stored & hashed; OCR not run by default (set OCR_IMAGES=true to enable).",
        failure_category: null,
        failure_detail: null,
        user_action_needed:
          role === "inline_signature" || role === "embedded_logo"
            ? "Image is a likely signature/logo and excluded from AI ingestion text."
            : null,
        extraction_method: "image_metadata",
        text_extracted: false,
        text_quality: "unknown",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: null,
        structured_data: null,
      },
      buffer: attachmentData,
      processedBuffer: null,
    };
  }

  // ============================================================
  // EML — recursively parse with mailparser
  // ============================================================
  if (mimeType === "message/rfc822" || fileExtension === "eml") {
    try {
      const mailparserMod = await import("mailparser");
      type ParsedMail = {
        subject?: string;
        from?: { text?: string };
        to?: { text?: string };
        date?: Date;
        text?: string;
        html?: string | false;
        attachments?: Array<{
          filename?: string;
          contentType?: string;
          content?: Buffer;
        }>;
      };
      const simpleParser = (
        mailparserMod as unknown as {
          simpleParser: (src: Buffer) => Promise<ParsedMail>;
        }
      ).simpleParser;

      const collected: ChildEmailRecord[] = [];
      const MAX_DEPTH = 8; // hard cap to prevent pathological recursion
      let topText = "";

      const walk = async (
        bytes: Buffer,
        parentId: string,
        depth: number,
      ): Promise<void> => {
        if (depth > MAX_DEPTH) return;
        const parsed = await simpleParser(bytes);
        const childText = parsed.text || "";
        if (depth === 0) topText = childText;
        const childHtml =
          typeof parsed.html === "string" && parsed.html.length > 0
            ? parsed.html
            : null;
        const idSuffix =
          parentId.slice(0, 8) || partId || `d${depth}_${collected.length}`;
        const docId = `gmail_${messageId}_eml_${idSuffix}_d${depth}`;
        collected.push({
          document_id: docId,
          parent_attachment_id: parentId,
          subject: parsed.subject ?? null,
          from: parsed.from?.text ?? null,
          to: parsed.to?.text ?? null,
          date: parsed.date ? parsed.date.toISOString() : null,
          text: childText || null,
          html: childHtml,
          attachment_count: parsed.attachments?.length ?? 0,
        });
        // Recurse into any nested message/rfc822 attachments
        for (const att of parsed.attachments ?? []) {
          const ct = (att.contentType || "").toLowerCase();
          const fn = (att.filename || "").toLowerCase();
          const isNested =
            ct === "message/rfc822" || fn.endsWith(".eml") || fn.endsWith(".msg");
          if (isNested && att.content && Buffer.isBuffer(att.content)) {
            try {
              await walk(att.content, docId, depth + 1);
            } catch {
              // swallow per-child failures so the outer EML still succeeds
            }
          }
        }
      };

      await walk(attachmentData, attachmentId, 0);

      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "eml_parser" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "child_email",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "eml_parser",
          text_extracted: topText.length > 0,
          text_quality: topText.length > 0 ? "high" : "unknown",
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: null,
          sheet_names: null,
          extracted_text: topText || null,
          structured_data: null,
          child_emails: collected,
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_failed",
          "failed",
          startTime,
          {
            extraction_method: "eml_parser",
            error_category: "parser_error",
            error_message: errMsg,
            user_action_needed:
              "Embedded .eml could not be parsed. Open in a mail client to inspect.",
          },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "child_email",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "failed",
          skip_reason: null,
          failure_category: "parser_error",
          failure_detail: errMsg,
          user_action_needed:
            "Embedded .eml could not be parsed. Open in a mail client to inspect.",
          extraction_method: "eml_parser",
          text_extracted: false,
          text_quality: "unknown",
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: null,
          sheet_names: null,
          extracted_text: null,
          structured_data: null,
          errors: [errMsg],
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }
  }

  // Unsupported MIME type
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_extraction_failed",
        "unsupported",
        startTime,
        {
          extraction_method: "none",
          error_category: "unsupported_file_type",
          error_message: `MIME type ${mimeType} is not supported for text extraction`,
          user_action_needed: `Attachment .${fileExtension} is not yet supported for text extraction. The file is downloaded and hashed in the bundle.`,
        },
      ),
    );
    return {
      result: {
        ...base,
        attachment_role: "unknown",
        is_supported: false,
        was_downloaded: true,
        extraction_status: "unsupported",
        skip_reason: `File type ${mimeType} (.${fileExtension}) is not supported for text extraction`,
        failure_category: "unsupported_file_type",
        failure_detail: `No parser available for ${mimeType}`,
        user_action_needed: `Attachment .${fileExtension} is not supported. Raw file is included in the bundle.`,
        extraction_method: "none",
        text_extracted: false,
        text_quality: "unknown",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: null,
        structured_data: null,
      },
      buffer: attachmentData,
      processedBuffer: null,
    };
  }

  // Extraction
  processingLog.push(
    makeLogEntry(
      messageId,
      attachmentId,
      filename,
      "attachment_extraction_started",
      "pending",
      startTime,
    ),
  );

  try {
    if (mimeType === "text/plain") {
      const text = attachmentData.toString("utf-8");
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "plain_text" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "plain_text",
          text_extracted: true,
          text_quality: "high",
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: null,
          sheet_names: null,
          extracted_text: text,
          structured_data: null,
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }

    if (mimeType === "text/html") {
      const { stripHtml } = await import("./gmail.js");
      const html = attachmentData.toString("utf-8");
      const stripped = stripHtml(html);
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "html_to_text" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "html_to_text",
          text_extracted: true,
          text_quality: "high",
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: null,
          sheet_names: null,
          extracted_text: stripped,
          structured_data: null,
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }

    if (mimeType === "text/csv") {
      const csvText = attachmentData.toString("utf-8");
      const { extracted, structured } = extractTextFromCsv(csvText);
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "csv_parser" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "csv_parser",
          text_extracted: true,
          text_quality: "high",
          contains_structured_data: true,
          structured_data_type: "table",
          page_count: null,
          sheet_names: null,
          extracted_text: extracted,
          structured_data: structured,
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }

    if (mimeType === "application/json") {
      const jsonText = attachmentData.toString("utf-8");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        /* keep raw text */
      }
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "json_parser" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "json_parser",
          text_extracted: true,
          text_quality: "high",
          contains_structured_data: true,
          structured_data_type: "json",
          page_count: null,
          sheet_names: null,
          extracted_text: jsonText,
          structured_data:
            typeof parsed === "object" && parsed !== null
              ? (parsed as Record<string, unknown>)
              : null,
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }

    if (mimeType === "application/xml" || mimeType === "text/xml") {
      const xmlText = attachmentData.toString("utf-8");
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "xml_parser" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "xml_parser",
          text_extracted: true,
          text_quality: "high",
          contains_structured_data: true,
          structured_data_type: "xml",
          page_count: null,
          sheet_names: null,
          extracted_text: xmlText,
          structured_data: null,
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }

    // ============================================================
    // PDF — security pipeline + page-level extraction + OCR fallback
    // ============================================================
    if (mimeType === "application/pdf") {
      const pdfMeta = { messageId, attachmentId, filename };
      const warnings: string[] = [];
      const errors: string[] = [];
      const deps = getDependencyReport();

      console.log("[pdf.analyze.started]", pdfMeta);
      const analysis: PdfSecurityAnalysis = await analyzePdfSecurity(attachmentData);
      console.log("[pdf.analyze.completed]", {
        ...pdfMeta,
        is_encrypted: analysis.is_encrypted,
        requires_password: analysis.requires_password,
        permissions: analysis.permissions,
        page_count: analysis.page_count,
      });

      let workingBuffer: Buffer = attachmentData;
      let processedBuffer: Buffer | null = null;
      let resolvedPageCount: number | null = analysis.page_count;
      let unlockAttempted = false;
      let unlockStatus: "success" | "failed" | null = null;
      let unlockError: string | null = null;
      let unlockPermissionsWereRestricted = false;
      let securityRemoved = false;
      let securityRemovalMethod: "qpdf" | "none" | "failed" = "none";
      let securityRemovalError: string | null = null;

      const hasRestrictions =
        analysis.is_encrypted ||
        Object.values(analysis.permissions).some((v) => v === false);

      // STEP 1: Try pdf-parse first
      let parseResult: { text: string; numpages: number } | null = null;
      let parseError: string | null = null;
      try {
        console.log("[pdf.parse.started]", pdfMeta);
        parseResult = await parsePdfBuffer(workingBuffer);
        console.log("[pdf.parse.completed]", {
          ...pdfMeta,
          pages: parseResult.numpages,
          chars: parseResult.text.length,
        });
        if (resolvedPageCount === null && parseResult.numpages > 0) {
          resolvedPageCount = parseResult.numpages;
        }
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
        console.log("[pdf.parse.failed]", { ...pdfMeta, error: parseError });
      }

      const parsedTextSoFar = parseResult ? parseResult.text.trim() : "";
      const needUnlock =
        hasRestrictions &&
        (parseError !== null ||
          parsedTextSoFar.length < OCR_TRIGGER_CHAR_THRESHOLD);

      // STEP 2: qpdf unlock if required & possible
      if (needUnlock) {
        unlockAttempted = true;
        processingLog.push(
          makeLogEntry(
            messageId,
            attachmentId,
            filename,
            "pdf_security_removal_attempted",
            "pending",
            startTime,
          ),
        );
        if (!deps?.qpdf.available) {
          unlockStatus = "failed";
          unlockError = "qpdf binary not available";
          securityRemovalMethod = "failed";
          securityRemovalError = "qpdf binary not available on server";
          console.log("[pdf.unlock.failed]", {
            ...pdfMeta,
            error: securityRemovalError,
          });
          processingLog.push(
            makeLogEntry(
              messageId,
              attachmentId,
              filename,
              "pdf_security_removal_failed",
              "failed",
              startTime,
              {
                error_category: "environment_error",
                error_message: securityRemovalError,
              },
            ),
          );
        } else {
          console.log("[pdf.unlock.started]", pdfMeta);
          const tmp = await mkdtemp(join(tmpdir(), "pdf-unlock-"));
          try {
            const inP = join(tmp, "in.pdf");
            const outP = join(tmp, "out.pdf");
            await writeFile(inP, attachmentData);
            const u = await attemptPdfUnlock(inP, outP);
            unlockPermissionsWereRestricted = u.permissions_were_restricted;
            if (u.success && u.output_path) {
              unlockStatus = "success";
              securityRemoved = true;
              securityRemovalMethod = "qpdf";
              workingBuffer = await readFile(u.output_path);
              processedBuffer = workingBuffer;
              base.processed_sha256 = sha256Hex(workingBuffer);
              console.log("[pdf.unlock.completed]", pdfMeta);
              processingLog.push(
                makeLogEntry(
                  messageId,
                  attachmentId,
                  filename,
                  "pdf_security_removal_completed",
                  "success",
                  startTime,
                ),
              );
              // Retry parse on unlocked
              try {
                const retried = await parsePdfBuffer(workingBuffer);
                parseResult = retried;
                parseError = null;
                if (resolvedPageCount === null && retried.numpages > 0) {
                  resolvedPageCount = retried.numpages;
                }
              } catch (rerr) {
                parseError = rerr instanceof Error ? rerr.message : String(rerr);
              }
            } else {
              unlockStatus = "failed";
              unlockError = u.error;
              securityRemovalMethod = "failed";
              securityRemovalError = u.error;
              console.log("[pdf.unlock.failed]", {
                ...pdfMeta,
                category: u.failure_category,
                error: u.error,
              });
              processingLog.push(
                makeLogEntry(
                  messageId,
                  attachmentId,
                  filename,
                  "pdf_security_removal_failed",
                  "failed",
                  startTime,
                  {
                    error_category: "encrypted_or_password_protected",
                    error_message: u.error ?? "qpdf failed",
                  },
                ),
              );
            }
          } finally {
            await rm(tmp, { recursive: true, force: true }).catch(() => {});
          }
        }
      }

      if (resolvedPageCount === null) {
        resolvedPageCount = await getPdfPageCount(workingBuffer);
      }

      // STEP 3: Page-level extraction (preferred via pdftotext)
      let pages: PageRecord[] = [];
      let pagesError: string | null = null;
      if (resolvedPageCount && resolvedPageCount > 0) {
        const pgRes = await extractPdfPages(workingBuffer, resolvedPageCount);
        pages = pgRes.pages;
        pagesError = pgRes.error;
      }

      const parsedText = parseResult ? parseResult.text.trim() : "";
      const pagesText = pages.length > 0 ? buildPagedExtractedText(pages) : "";
      const finalParserText =
        pagesText.length >= parsedText.length ? pagesText : parsedText;

      const isEncryptedFlag = analysis.is_encrypted;

      // SUCCESS via parser/page-text
      if (finalParserText.length >= OCR_TRIGGER_CHAR_THRESHOLD) {
        const quality = finalParserText.length < 500 ? "medium" : "high";
        if (securityRemoved && unlockPermissionsWereRestricted) {
          warnings.push(
            "PDF had usage restrictions which were removed successfully.",
          );
        }
        const pagesExtracted = pages.filter((p) => p.text_extracted).length;
        const pagesFailed = pages.length - pagesExtracted;
        processingLog.push(
          makeLogEntry(
            messageId,
            attachmentId,
            filename,
            "attachment_extraction_completed",
            "success",
            startTime,
            { extraction_method: "pdf_parser" },
          ),
        );
        return {
          result: {
            ...base,
            attachment_role: "document",
            is_supported: true,
            was_downloaded: true,
            extraction_status: "success",
            skip_reason: null,
            failure_category: null,
            failure_detail: null,
            user_action_needed:
              securityRemoved && unlockPermissionsWereRestricted
                ? "PDF had usage restrictions which were removed successfully."
                : null,
            extraction_method: "pdf_parser",
            text_extracted: true,
            text_quality: quality,
            is_encrypted: isEncryptedFlag,
            unlock_attempted: unlockAttempted,
            unlock_status: unlockStatus,
            unlock_error: unlockError,
            security_removed: securityRemoved,
            security_removal_method: securityRemovalMethod,
            security_removal_error: securityRemovalError,
            fallback_used: false,
            fallback_method: null,
            pages,
            pages_extracted_count: pagesExtracted,
            pages_failed_count: pagesFailed,
            contains_structured_data: false,
            structured_data_type: "none",
            page_count: resolvedPageCount,
            sheet_names: null,
            extracted_text: finalParserText,
            structured_data: null,
            warnings,
            errors,
          },
          buffer: attachmentData,
          processedBuffer,
        };
      }

      // STEP 4: OCR fallback (if enabled & possible)
      if (isOcrEnabled()) {
        if (!deps?.pdftoppm.available) {
          // OCR unavailable as environment_error
          const userAction =
            "PDF needs OCR but pdftoppm (poppler-utils) is not installed on the server. Install poppler-utils or run OCR externally.";
          processingLog.push(
            makeLogEntry(
              messageId,
              attachmentId,
              filename,
              "attachment_extraction_failed",
              "failed",
              startTime,
              {
                extraction_method: "ocr",
                error_category: "ocr_not_configured",
                error_message: "pdftoppm missing on server",
                user_action_needed: userAction,
              },
            ),
          );
          return {
            result: {
              ...base,
              attachment_role: "document",
              is_supported: true,
              was_downloaded: true,
              extraction_status: "failed",
              skip_reason: null,
              failure_category: "ocr_not_configured",
              failure_detail: "pdftoppm/poppler-utils missing on server",
              user_action_needed: userAction,
              extraction_method: "none",
              text_extracted: false,
              text_quality: "unknown",
              is_encrypted: isEncryptedFlag,
              unlock_attempted: unlockAttempted,
              unlock_status: unlockStatus,
              unlock_error: unlockError,
              security_removed: securityRemoved,
              security_removal_method: securityRemovalMethod,
              security_removal_error: securityRemovalError,
              fallback_used: false,
              fallback_method: null,
              pages,
              pages_extracted_count: pages.filter((p) => p.text_extracted).length,
              pages_failed_count: pages.filter((p) => !p.text_extracted).length,
              contains_structured_data: false,
              structured_data_type: "none",
              page_count: resolvedPageCount,
              sheet_names: null,
              extracted_text: null,
              structured_data: null,
              warnings,
              errors: pagesError ? [...errors, pagesError] : errors,
            },
            buffer: attachmentData,
            processedBuffer,
          };
        }
        try {
          const ocr = await ocrPdfPages(workingBuffer, pdfMeta);
          if (ocr.error) {
            throw new Error(ocr.error);
          }
          const ocrText = ocr.pages
            .map((p) =>
              p.text ? `--- Page ${p.page_number} ---\n${p.text}\n` : "",
            )
            .filter((s) => s.length > 0)
            .join("\n")
            .trim();
          if (ocrText.length === 0) {
            throw new Error("OCR returned no text");
          }
          const ocrConfidence =
            ocrText.length < 200
              ? "low"
              : ocrText.length < 2000
                ? "medium"
                : "high";
          warnings.push(
            `OCR fallback used (${ocr.pagesProcessed} page(s) OCR'd${
              ocr.pagesTotal && ocr.pagesTotal > ocr.pagesProcessed
                ? `; ${ocr.pagesTotal - ocr.pagesProcessed} skipped due to ${OCR_MAX_PAGES}-page cap`
                : ""
            }).`,
          );
          if (ocrConfidence === "low") {
            warnings.push("OCR text marked LOW CONFIDENCE.");
          }
          // Merge per-page OCR records into pages[]
          const mergedPages: PageRecord[] = [];
          const pageNoMap = new Map<number, PageRecord>();
          for (const p of pages) pageNoMap.set(p.page_number, p);
          for (const op of ocr.pages) {
            const existing = pageNoMap.get(op.page_number);
            if (existing && existing.text_extracted) {
              mergedPages.push(existing);
            } else {
              mergedPages.push(op);
              pageNoMap.set(op.page_number, op);
            }
          }
          for (const [, p] of pageNoMap) {
            if (!mergedPages.some((m) => m.page_number === p.page_number)) {
              mergedPages.push(p);
            }
          }
          mergedPages.sort((a, b) => a.page_number - b.page_number);
          processingLog.push(
            makeLogEntry(
              messageId,
              attachmentId,
              filename,
              "attachment_extraction_completed",
              "success",
              startTime,
              { extraction_method: "ocr" },
            ),
          );
          return {
            result: {
              ...base,
              attachment_role: "document",
              is_supported: true,
              was_downloaded: true,
              extraction_status: ocrConfidence === "low" ? "partial" : "success",
              skip_reason: null,
              failure_category: null,
              failure_detail: null,
              user_action_needed:
                ocrConfidence === "low"
                  ? "OCR returned low-confidence text. Verify accuracy if it matters."
                  : null,
              extraction_method: parsedText.length > 0 ? "pdf_parser+ocr" : "ocr",
              text_extracted: true,
              text_quality: ocrConfidence,
              is_encrypted: isEncryptedFlag,
              unlock_attempted: unlockAttempted,
              unlock_status: unlockStatus,
              unlock_error: unlockError,
              security_removed: securityRemoved,
              security_removal_method: securityRemovalMethod,
              security_removal_error: securityRemovalError,
              fallback_used: true,
              fallback_method: "ocr",
              pages: mergedPages,
              pages_extracted_count: mergedPages.filter((p) => p.text_extracted)
                .length,
              pages_failed_count: mergedPages.filter((p) => !p.text_extracted)
                .length,
              contains_structured_data: false,
              structured_data_type: "none",
              page_count: resolvedPageCount,
              sheet_names: null,
              extracted_text: ocrText,
              structured_data: null,
              warnings,
              errors,
            },
            buffer: attachmentData,
            processedBuffer,
            ocrPageImages: ocr.pageImages.length > 0 ? ocr.pageImages : null,
          };
        } catch (ocrErr) {
          const errMsg =
            ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
          // Try last-resort image conversion
          let imagesRendered = 0;
          try {
            const tmp = await mkdtemp(join(tmpdir(), "pdf-img-ref-"));
            const inP = join(tmp, "in.pdf");
            await writeFile(inP, workingBuffer);
            const conv = await convertPdfToImages(inP, {
              dpi: 150,
              maxPages: OCR_MAX_PAGES,
            });
            if (conv.success) {
              imagesRendered = conv.image_paths.length;
              if (conv.output_dir) {
                await rm(conv.output_dir, {
                  recursive: true,
                  force: true,
                }).catch(() => {});
              }
            }
            await rm(tmp, { recursive: true, force: true }).catch(() => {});
          } catch {
            /* swallow */
          }
          if (imagesRendered > 0) {
            warnings.push(
              `Fallback image conversion succeeded: ${imagesRendered} pages rendered.`,
            );
          }
          const userAction = analysis.requires_password
            ? "PDF is password protected. Provide password or remove security manually."
            : "PDF appears to be a scanned/image-based document and OCR failed. Verify the source document is not corrupt.";
          processingLog.push(
            makeLogEntry(
              messageId,
              attachmentId,
              filename,
              "attachment_extraction_failed",
              "failed",
              startTime,
              {
                extraction_method: "ocr",
                error_category: "ocr_failed",
                error_message: errMsg,
                user_action_needed: userAction,
              },
            ),
          );
          return {
            result: {
              ...base,
              attachment_role: "document",
              is_supported: true,
              was_downloaded: true,
              extraction_status: "failed",
              skip_reason: null,
              failure_category: analysis.requires_password
                ? "encrypted_or_password_protected"
                : "ocr_failed",
              failure_detail: errMsg,
              user_action_needed: userAction,
              extraction_method: "ocr",
              text_extracted: false,
              text_quality: "unknown",
              is_encrypted: isEncryptedFlag,
              unlock_attempted: unlockAttempted,
              unlock_status: unlockStatus,
              unlock_error: unlockError,
              security_removed: securityRemoved,
              security_removal_method: securityRemovalMethod,
              security_removal_error: securityRemovalError,
              fallback_used: imagesRendered > 0,
              fallback_method: imagesRendered > 0 ? "pdf_to_images" : "ocr",
              pages,
              pages_extracted_count: pages.filter((p) => p.text_extracted).length,
              pages_failed_count: pages.filter((p) => !p.text_extracted).length,
              contains_structured_data: false,
              structured_data_type: "none",
              page_count: resolvedPageCount,
              sheet_names: null,
              extracted_text: null,
              structured_data: null,
              warnings,
              errors: [errMsg, ...errors],
            },
            buffer: attachmentData,
            processedBuffer,
          };
        }
      }

      // OCR disabled — emit failure with metadata
      const userActionDisabled = analysis.requires_password
        ? "PDF is password protected. Provide password or remove security manually."
        : unlockStatus === "failed"
          ? "PDF could not be unlocked. Provide an unsecured copy and re-export."
          : "PDF parser produced no text and OCR is disabled. Set OCR_ENABLED=true to extract text from scanned PDFs.";
      const failCategory: FailureCategory = analysis.requires_password
        ? "encrypted_or_password_protected"
        : parseError
          ? "parser_error"
          : "ocr_failed";
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_failed",
          "failed",
          startTime,
          {
            extraction_method: "pdf_parser",
            error_category: failCategory,
            error_message: parseError ?? "No text extracted and OCR disabled.",
            user_action_needed: userActionDisabled,
          },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "failed",
          skip_reason: null,
          failure_category: failCategory,
          failure_detail: parseError ?? "pdf-parse produced no text and OCR disabled.",
          user_action_needed: userActionDisabled,
          extraction_method: "pdf_parser",
          text_extracted: false,
          text_quality: "unknown",
          is_encrypted: isEncryptedFlag,
          unlock_attempted: unlockAttempted,
          unlock_status: unlockStatus,
          unlock_error: unlockError,
          security_removed: securityRemoved,
          security_removal_method: securityRemovalMethod,
          security_removal_error: securityRemovalError,
          fallback_used: false,
          fallback_method: null,
          pages,
          pages_extracted_count: pages.filter((p) => p.text_extracted).length,
          pages_failed_count: pages.filter((p) => !p.text_extracted).length,
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: resolvedPageCount,
          sheet_names: null,
          extracted_text: null,
          structured_data: null,
          warnings,
          errors: parseError ? [parseError, ...errors] : errors,
        },
        buffer: attachmentData,
        processedBuffer,
      };
    }

    // DOCX
    if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimeType === "application/msword"
    ) {
      const mammoth = await import("mammoth");
      let result: { value: string; messages: { message: string }[] };
      try {
        result = await mammoth.extractRawText({ buffer: attachmentData });
      } catch (docxErr) {
        const errMsg = docxErr instanceof Error ? docxErr.message : String(docxErr);
        const isEncrypted =
          errMsg.toLowerCase().includes("encrypt") ||
          errMsg.toLowerCase().includes("password");
        const category: FailureCategory = isEncrypted
          ? "encrypted_or_password_protected"
          : "parser_error";
        const userAction = isEncrypted
          ? "Password protected document could not be opened. Remove password protection and rerun."
          : `DOCX parsing failed: ${errMsg}`;
        processingLog.push(
          makeLogEntry(
            messageId,
            attachmentId,
            filename,
            "attachment_extraction_failed",
            "failed",
            startTime,
            {
              extraction_method: "docx_parser",
              error_category: category,
              error_message: errMsg,
              user_action_needed: userAction,
            },
          ),
        );
        return {
          result: {
            ...base,
            attachment_role: "document",
            is_supported: true,
            was_downloaded: true,
            extraction_status: "failed",
            skip_reason: null,
            failure_category: category,
            failure_detail: errMsg,
            user_action_needed: userAction,
            extraction_method: "docx_parser",
            text_extracted: false,
            text_quality: "unknown",
            contains_structured_data: false,
            structured_data_type: "none",
            page_count: null,
            sheet_names: null,
            extracted_text: null,
            structured_data: null,
            errors: [errMsg],
          },
          buffer: attachmentData,
          processedBuffer: null,
        };
      }
      const warns = result.messages.map((m) => m.message);
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "docx_parser" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "docx_parser",
          text_extracted: true,
          text_quality: "high",
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: null,
          sheet_names: null,
          extracted_text: result.value.trim() || null,
          structured_data: null,
          warnings: warns,
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }

    // XLSX / XLS
    if (
      mimeType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel"
    ) {
      const XLSX = await import("xlsx");
      let workbook: ReturnType<typeof XLSX.read>;
      try {
        workbook = XLSX.read(attachmentData, { type: "buffer" });
      } catch (xlsxErr) {
        const errMsg = xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr);
        const isEncrypted =
          errMsg.toLowerCase().includes("encrypt") ||
          errMsg.toLowerCase().includes("password");
        const category: FailureCategory = isEncrypted
          ? "encrypted_or_password_protected"
          : "corrupt_or_malformed";
        const userAction = isEncrypted
          ? "Password protected or encrypted spreadsheet could not be read."
          : "Spreadsheet is corrupted or unreadable. Resave the file in Excel.";
        processingLog.push(
          makeLogEntry(
            messageId,
            attachmentId,
            filename,
            "attachment_extraction_failed",
            "failed",
            startTime,
            {
              extraction_method: "xlsx_parser",
              error_category: category,
              error_message: errMsg,
              user_action_needed: userAction,
            },
          ),
        );
        return {
          result: {
            ...base,
            attachment_role: "document",
            is_supported: true,
            was_downloaded: true,
            extraction_status: "failed",
            skip_reason: null,
            failure_category: category,
            failure_detail: errMsg,
            user_action_needed: userAction,
            extraction_method: "xlsx_parser",
            text_extracted: false,
            text_quality: "unknown",
            contains_structured_data: true,
            structured_data_type: "spreadsheet",
            page_count: null,
            sheet_names: null,
            extracted_text: null,
            structured_data: null,
            errors: [errMsg],
          },
          buffer: attachmentData,
          processedBuffer: null,
        };
      }
      const sheetNames = workbook.SheetNames;
      const allSheetsText: string[] = [];
      const allSheetsData: Record<string, unknown[][]> = {};
      for (const sheetName of sheetNames) {
        const ws = workbook.Sheets[sheetName];
        if (!ws) continue;
        const csv = XLSX.utils.sheet_to_csv(ws);
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
        allSheetsText.push(`--- Sheet: ${sheetName} ---\n${csv}`);
        allSheetsData[sheetName] = rows;
      }
      processingLog.push(
        makeLogEntry(
          messageId,
          attachmentId,
          filename,
          "attachment_extraction_completed",
          "success",
          startTime,
          { extraction_method: "xlsx_parser" },
        ),
      );
      return {
        result: {
          ...base,
          attachment_role: "document",
          is_supported: true,
          was_downloaded: true,
          extraction_status: "success",
          skip_reason: null,
          failure_category: null,
          failure_detail: null,
          user_action_needed: null,
          extraction_method: "xlsx_parser",
          text_extracted: true,
          text_quality: "high",
          contains_structured_data: true,
          structured_data_type: "spreadsheet",
          page_count: null,
          sheet_names: sheetNames,
          extracted_text: allSheetsText.join("\n\n"),
          structured_data: { sheets: allSheetsData },
        },
        buffer: attachmentData,
        processedBuffer: null,
      };
    }

    // Fallback (shouldn't reach here for SUPPORTED_MIME_TYPES list)
    return {
      result: {
        ...base,
        attachment_role: "unknown",
        is_supported: false,
        was_downloaded: true,
        extraction_status: "unsupported",
        skip_reason: `No specific extractor for ${mimeType}`,
        failure_category: "unsupported_file_type",
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "none",
        text_extracted: false,
        text_quality: "unknown",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: null,
        structured_data: null,
      },
      buffer: attachmentData,
      processedBuffer: null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, messageId, attachmentId, filename },
      "Attachment extraction error",
    );
    processingLog.push(
      makeLogEntry(
        messageId,
        attachmentId,
        filename,
        "attachment_extraction_failed",
        "failed",
        startTime,
        {
          error_category: "unknown_error",
          error_message: errMsg,
        },
      ),
    );
    return {
      result: {
        ...base,
        attachment_role: "unknown",
        is_supported: true,
        was_downloaded: true,
        extraction_status: "failed",
        skip_reason: null,
        failure_category: "unknown_error",
        failure_detail: errMsg,
        user_action_needed:
          "An unexpected error occurred during extraction. Retry the export.",
        extraction_method: "none",
        text_extracted: false,
        text_quality: "unknown",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: null,
        structured_data: null,
        errors: [errMsg],
      },
      buffer: attachmentData,
      processedBuffer: null,
    };
  }
}

/**
 * Build the deterministic in-ZIP storage path for an attachment.
 * Pattern: extracted_attachments/<messageId>/<3-digit-partIdx>_<sha256[:8]>_<safe_filename>
 */
export function buildStoragePath(
  messageId: string,
  partIndex: number,
  sha256: string | null,
  safeFilename: string,
): string {
  const partStr = String(partIndex + 1).padStart(3, "0");
  const shaPrefix = sha256 ? sha256.slice(0, 8) : "nohash00";
  return `extracted_attachments/${messageId}/${partStr}_${shaPrefix}_${safeFilename}`;
}
