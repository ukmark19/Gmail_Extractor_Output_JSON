import { gmail_v1 } from "googleapis";
import { createHash } from "crypto";
import { logger } from "./logger";
import { decodeBase64 } from "./gmail";

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, "_").trim();
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
  | "network_fetch_error"
  | "permission_error"
  | "unknown_error";

export type ExtractionStatus = "success" | "partial" | "failed" | "unsupported" | "skipped";

export type ExtractionMethod =
  | "pdf_parser"
  | "docx_parser"
  | "xlsx_parser"
  | "csv_parser"
  | "json_parser"
  | "xml_parser"
  | "html_to_text"
  | "plain_text"
  | "none";

export interface AttachmentExtractionResult {
  attachment_id: string;
  message_id: string;
  parent_document_id: string;
  part_id: string;
  filename: string;
  safe_filename: string;
  storage_path: string;
  sha256: string | null;
  mime_type: string;
  file_extension: string;
  size_bytes: number;
  content_id: string;
  is_inline: boolean;
  is_embedded: boolean;
  is_supported: boolean;
  was_downloaded: boolean;
  extraction_status: ExtractionStatus;
  skip_reason: string | null;
  failure_category: FailureCategory | null;
  failure_detail: string | null;
  user_action_needed: string | null;
  extraction_method: ExtractionMethod;
  text_quality: "high" | "medium" | "low" | "unknown";
  contains_structured_data: boolean;
  structured_data_type: "table" | "spreadsheet" | "json" | "xml" | "none";
  page_count: number | null;
  sheet_names: string[] | null;
  extracted_text: string | null;
  structured_data: Record<string, unknown> | null;
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

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

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
]);

const OCR_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/webp",
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
  extras: Partial<ProcessingLogEntry> = {}
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

function extractTextFromCsv(text: string): { extracted: string; structured: Record<string, unknown> } {
  const lines = text.trim().split("\n");
  const headers = lines[0]?.split(",").map((h) => h.trim().replace(/^"|"$/g, "")) || [];
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ""; });
    rows.push(row);
  }
  return {
    extracted: text,
    structured: { headers, row_count: rows.length, sample_rows: rows.slice(0, 5) },
  };
}

export async function extractAttachmentContent(
  gmailClient: gmail_v1.Gmail,
  messageId: string,
  part: {
    partId?: string | null;
    mimeType?: string | null;
    filename?: string | null;
    body?: { attachmentId?: string | null; size?: number | null } | null;
    headers?: { name?: string | null; value?: string | null }[] | null;
  },
  processingLog: ProcessingLogEntry[]
): Promise<AttachmentExtractionResult> {
  const startTime = Date.now();
  const filename = part.filename || "unnamed";
  const mimeType = part.mimeType || "application/octet-stream";
  const attachmentId = part.body?.attachmentId || "";
  const sizeBytes = part.body?.size || 0;
  const partId = part.partId || "";
  const fileExtension = getFileExtension(filename);
  const contentIdHeader = (part.headers || []).find((h) => h.name?.toLowerCase() === "content-id");
  const contentId = contentIdHeader?.value?.replace(/[<>]/g, "") || "";
  const isInline = !!(part.headers || []).find(
    (h) => h.name?.toLowerCase() === "content-disposition" && h.value?.includes("inline")
  );

  const safeFilename = sanitizeFilename(filename);
  const parentDocumentId = `gmail_${messageId}`;
  const storagePath = `attachments/${parentDocumentId}/${safeFilename}`;

  const base: Omit<AttachmentExtractionResult, "extraction_status" | "failure_category" | "failure_detail" | "user_action_needed" | "extraction_method" | "text_quality" | "contains_structured_data" | "structured_data_type" | "page_count" | "sheet_names" | "extracted_text" | "structured_data" | "is_supported" | "was_downloaded" | "skip_reason"> = {
    attachment_id: attachmentId,
    message_id: messageId,
    parent_document_id: parentDocumentId,
    part_id: partId,
    filename,
    safe_filename: safeFilename,
    storage_path: storagePath,
    sha256: null,
    mime_type: mimeType,
    file_extension: fileExtension,
    size_bytes: sizeBytes,
    content_id: contentId,
    is_inline: isInline,
    is_embedded: isInline && !!contentId,
    warnings: [],
    errors: [],
  };

  // Size check
  if (sizeBytes > MAX_ATTACHMENT_SIZE) {
    processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_failed", "skipped", startTime, {
      error_category: "too_large",
      error_message: `Attachment size ${sizeBytes} exceeds limit of ${MAX_ATTACHMENT_SIZE}`,
      user_action_needed: "Attachment exceeded configured size limit and was skipped. Increase max size or process manually.",
    }));
    return {
      ...base,
      is_supported: false,
      was_downloaded: false,
      extraction_status: "skipped",
      skip_reason: `File size ${(sizeBytes / 1024 / 1024).toFixed(1)} MB exceeds the 10 MB limit`,
      failure_category: "too_large",
      failure_detail: `Attachment is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB, limit is 10 MB`,
      user_action_needed: "Attachment exceeded configured size limit and was skipped. Increase max size or process manually.",
      extraction_method: "none",
      text_quality: "unknown",
      contains_structured_data: false,
      structured_data_type: "none",
      page_count: null,
      sheet_names: null,
      extracted_text: null,
      structured_data: null,
    };
  }

  // Image: no OCR support
  if (OCR_MIME_TYPES.has(mimeType)) {
    processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_failed", "unsupported", startTime, {
      extraction_method: "none",
      error_category: "unsupported_file_type",
      error_message: "Image OCR not available — no OCR engine configured",
      user_action_needed: "OCR is not supported in this build. Convert image content to text manually.",
    }));
    return {
      ...base,
      is_supported: false,
      was_downloaded: false,
      extraction_status: "unsupported",
      skip_reason: "Image OCR not supported. Only text-based formats are extracted.",
      failure_category: "unsupported_file_type",
      failure_detail: `Image type ${mimeType} requires OCR which is not configured`,
      user_action_needed: "OCR is not supported in this build. Convert image content to text manually or use a dedicated OCR tool.",
      extraction_method: "none",
      text_quality: "unknown",
      contains_structured_data: false,
      structured_data_type: "none",
      page_count: null,
      sheet_names: null,
      extracted_text: null,
      structured_data: null,
    };
  }

  // Unsupported MIME type
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_failed", "unsupported", startTime, {
      extraction_method: "none",
      error_category: "unsupported_file_type",
      error_message: `MIME type ${mimeType} is not supported`,
      user_action_needed: `Attachment type .${fileExtension} is not yet supported for text extraction. Raw metadata exported only.`,
    }));
    return {
      ...base,
      is_supported: false,
      was_downloaded: false,
      extraction_status: "unsupported",
      skip_reason: `File type ${mimeType} (.${fileExtension}) is not supported for text extraction`,
      failure_category: "unsupported_file_type",
      failure_detail: `No parser available for ${mimeType}`,
      user_action_needed: `Attachment type .${fileExtension} is not yet supported for text extraction. Raw metadata exported only.`,
      extraction_method: "none",
      text_quality: "unknown",
      contains_structured_data: false,
      structured_data_type: "none",
      page_count: null,
      sheet_names: null,
      extracted_text: null,
      structured_data: null,
    };
  }

  // No attachment ID — can't download
  if (!attachmentId) {
    return {
      ...base,
      is_supported: true,
      was_downloaded: false,
      extraction_status: "failed",
      skip_reason: null,
      failure_category: "network_fetch_error",
      failure_detail: "No Gmail attachment ID available to download this attachment",
      user_action_needed: null,
      extraction_method: "none",
      text_quality: "unknown",
      contains_structured_data: false,
      structured_data_type: "none",
      page_count: null,
      sheet_names: null,
      extracted_text: null,
      structured_data: null,
    };
  }

  // Download attachment
  processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_download_started", "pending", startTime));

  let attachmentData: Buffer;
  try {
    const attResponse = await gmailClient.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    const rawData = attResponse.data.data;
    if (!rawData) {
      throw new Error("Empty attachment data received from Gmail API");
    }
    const base64 = rawData.replace(/-/g, "+").replace(/_/g, "/");
    attachmentData = Buffer.from(base64, "base64");
    base.sha256 = sha256Hex(attachmentData);
    processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_download_completed", "success", startTime));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_download_completed", "failed", startTime, {
      error_category: "network_fetch_error",
      error_message: errMsg,
    }));
    return {
      ...base,
      is_supported: true,
      was_downloaded: false,
      extraction_status: "failed",
      skip_reason: null,
      failure_category: "network_fetch_error",
      failure_detail: `Failed to download attachment from Gmail: ${errMsg}`,
      user_action_needed: "Retry the export. If the error persists, the attachment may have been deleted.",
      extraction_method: "none",
      text_quality: "unknown",
      contains_structured_data: false,
      structured_data_type: "none",
      page_count: null,
      sheet_names: null,
      extracted_text: null,
      structured_data: null,
    };
  }

  // Extract content by type
  processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_started", "pending", startTime));

  try {
    // Plain text / HTML / JSON / XML / CSV
    if (mimeType === "text/plain") {
      const text = attachmentData.toString("utf-8");
      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "plain_text" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "plain_text",
        text_quality: "high",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: text,
        structured_data: null,
      };
    }

    if (mimeType === "text/html") {
      const { stripHtml } = await import("./gmail.js");
      const html = attachmentData.toString("utf-8");
      const stripped = stripHtml(html);
      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "html_to_text" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "html_to_text",
        text_quality: "high",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: stripped,
        structured_data: null,
      };
    }

    if (mimeType === "text/csv") {
      const csvText = attachmentData.toString("utf-8");
      const { extracted, structured } = extractTextFromCsv(csvText);
      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "csv_parser" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "csv_parser",
        text_quality: "high",
        contains_structured_data: true,
        structured_data_type: "table",
        page_count: null,
        sheet_names: null,
        extracted_text: extracted,
        structured_data: structured,
      };
    }

    if (mimeType === "application/json") {
      const jsonText = attachmentData.toString("utf-8");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        // still export raw text
      }
      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "json_parser" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "json_parser",
        text_quality: "high",
        contains_structured_data: true,
        structured_data_type: "json",
        page_count: null,
        sheet_names: null,
        extracted_text: jsonText,
        structured_data: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null,
      };
    }

    if (mimeType === "application/xml" || mimeType === "text/xml") {
      const xmlText = attachmentData.toString("utf-8");
      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "xml_parser" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "xml_parser",
        text_quality: "high",
        contains_structured_data: true,
        structured_data_type: "xml",
        page_count: null,
        sheet_names: null,
        extracted_text: xmlText,
        structured_data: null,
      };
    }

    // PDF
    if (mimeType === "application/pdf") {
      // Import directly from lib/ to avoid pdf-parse v1's index.js debug-mode
      // side effect that tries to read a hard-coded test file at startup.
      const pdfParseModule: unknown = await import("pdf-parse/lib/pdf-parse.js");
      const pdfParseRaw =
        (pdfParseModule as { default?: unknown }).default ?? pdfParseModule;
      const pdfParse = pdfParseRaw as (
        data: Buffer,
        opts?: Record<string, unknown>,
      ) => Promise<{ text: string; numpages: number }>;
      let pdfData: { text: string; numpages: number };
      try {
        if (typeof pdfParse !== "function") {
          throw new Error(
            `pdf-parse export is not callable (got ${typeof pdfParse}). Check pdf-parse version — expected v1.x.`,
          );
        }
        pdfData = await pdfParse(attachmentData);
        console.log(
          `[pdf-extract] parser=pdf-parse@1 status=success pages=${pdfData.numpages} chars=${pdfData.text.length} file="${filename}"`,
        );
      } catch (pdfErr) {
        const errMsgRaw = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
        console.log(
          `[pdf-extract] parser=pdf-parse@1 status=failed file="${filename}" error="${errMsgRaw}"`,
        );
        const errMsg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
        const isEncrypted =
          errMsg.toLowerCase().includes("encrypt") ||
          errMsg.toLowerCase().includes("password") ||
          errMsg.toLowerCase().includes("protected");
        const isCorrupt =
          errMsg.toLowerCase().includes("invalid") ||
          errMsg.toLowerCase().includes("corrupt") ||
          errMsg.toLowerCase().includes("malformed");
        const category: FailureCategory = isEncrypted
          ? "encrypted_or_password_protected"
          : isCorrupt
          ? "corrupt_or_malformed"
          : "parser_error";
        const userAction = isEncrypted
          ? "Password protected PDF could not be opened. Remove the password or export an unsecured copy and rerun."
          : isCorrupt
          ? "Spreadsheet is corrupted or unreadable. Open and resave the file in a compatible app, then rerun."
          : `PDF parsing failed: ${errMsg}`;
        processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_failed", "failed", startTime, {
          extraction_method: "pdf_parser",
          error_category: category,
          error_message: errMsg,
          user_action_needed: userAction,
        }));
        return {
          ...base,
          is_supported: true,
          was_downloaded: true,
          extraction_status: "failed",
          skip_reason: null,
          failure_category: category,
          failure_detail: errMsg,
          user_action_needed: userAction,
          extraction_method: "pdf_parser",
          text_quality: "unknown",
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: null,
          sheet_names: null,
          extracted_text: null,
          structured_data: null,
          errors: [errMsg],
        };
      }
      const text = pdfData.text.trim();
      const quality = text.length < 50 ? "low" : text.length < 500 ? "medium" : "high";
      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "pdf_parser" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "pdf_parser",
        text_quality: quality,
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: pdfData.numpages,
        sheet_names: null,
        extracted_text: text || null,
        structured_data: null,
      };
    }

    // DOCX
    if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimeType === "application/msword"
    ) {
      const mammoth = await import("mammoth");
      let result: { value: string; messages: { message: string }[] };
      try {
        result = await mammoth.extractRawText({ buffer: attachmentData });
      } catch (docxErr) {
        const errMsg = docxErr instanceof Error ? docxErr.message : String(docxErr);
        const isEncrypted = errMsg.toLowerCase().includes("encrypt") || errMsg.toLowerCase().includes("password");
        const category: FailureCategory = isEncrypted ? "encrypted_or_password_protected" : "parser_error";
        const userAction = isEncrypted
          ? "Password protected document could not be opened. Remove password protection and rerun."
          : `DOCX parsing failed: ${errMsg}`;
        processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_failed", "failed", startTime, {
          extraction_method: "docx_parser",
          error_category: category,
          error_message: errMsg,
          user_action_needed: userAction,
        }));
        return {
          ...base,
          is_supported: true,
          was_downloaded: true,
          extraction_status: "failed",
          skip_reason: null,
          failure_category: category,
          failure_detail: errMsg,
          user_action_needed: userAction,
          extraction_method: "docx_parser",
          text_quality: "unknown",
          contains_structured_data: false,
          structured_data_type: "none",
          page_count: null,
          sheet_names: null,
          extracted_text: null,
          structured_data: null,
          errors: [errMsg],
        };
      }
      const warnings = result.messages.map((m) => m.message);
      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "docx_parser" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "docx_parser",
        text_quality: "high",
        contains_structured_data: false,
        structured_data_type: "none",
        page_count: null,
        sheet_names: null,
        extracted_text: result.value.trim() || null,
        structured_data: null,
        warnings,
      };
    }

    // XLSX / XLS
    if (
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel"
    ) {
      const XLSX = await import("xlsx");
      let workbook: ReturnType<typeof XLSX.read>;
      try {
        workbook = XLSX.read(attachmentData, { type: "buffer" });
      } catch (xlsxErr) {
        const errMsg = xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr);
        const isEncrypted = errMsg.toLowerCase().includes("encrypt") || errMsg.toLowerCase().includes("password");
        const category: FailureCategory = isEncrypted ? "encrypted_or_password_protected" : "corrupt_or_malformed";
        const userAction = isEncrypted
          ? "Password protected or encrypted spreadsheet could not be read. Remove file protection and rerun extraction."
          : "Spreadsheet is corrupted or unreadable. Open and resave the file in Excel, then rerun.";
        processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_failed", "failed", startTime, {
          extraction_method: "xlsx_parser",
          error_category: category,
          error_message: errMsg,
          user_action_needed: userAction,
        }));
        return {
          ...base,
          is_supported: true,
          was_downloaded: true,
          extraction_status: "failed",
          skip_reason: null,
          failure_category: category,
          failure_detail: errMsg,
          user_action_needed: userAction,
          extraction_method: "xlsx_parser",
          text_quality: "unknown",
          contains_structured_data: true,
          structured_data_type: "spreadsheet",
          page_count: null,
          sheet_names: null,
          extracted_text: null,
          structured_data: null,
          errors: [errMsg],
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

      processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_completed", "success", startTime, { extraction_method: "xlsx_parser" }));
      return {
        ...base,
        is_supported: true,
        was_downloaded: true,
        extraction_status: "success",
        skip_reason: null,
        failure_category: null,
        failure_detail: null,
        user_action_needed: null,
        extraction_method: "xlsx_parser",
        text_quality: "high",
        contains_structured_data: true,
        structured_data_type: "spreadsheet",
        page_count: null,
        sheet_names: sheetNames,
        extracted_text: allSheetsText.join("\n\n"),
        structured_data: { sheets: allSheetsData },
      };
    }

    // Fallback
    const fallbackText = attachmentData.toString("utf-8");
    return {
      ...base,
      is_supported: false,
      was_downloaded: true,
      extraction_status: "unsupported",
      skip_reason: `No specific extractor for ${mimeType}`,
      failure_category: "unsupported_file_type",
      failure_detail: null,
      user_action_needed: null,
      extraction_method: "none",
      text_quality: "low",
      contains_structured_data: false,
      structured_data_type: "none",
      page_count: null,
      sheet_names: null,
      extracted_text: fallbackText.substring(0, 1000) || null,
      structured_data: null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, messageId, attachmentId, filename }, "Attachment extraction error");
    processingLog.push(makeLogEntry(messageId, attachmentId, filename, "attachment_extraction_failed", "failed", startTime, {
      error_category: "unknown_error",
      error_message: errMsg,
    }));
    return {
      ...base,
      is_supported: true,
      was_downloaded: true,
      extraction_status: "failed",
      skip_reason: null,
      failure_category: "unknown_error",
      failure_detail: errMsg,
      user_action_needed: "An unexpected error occurred during extraction. Retry the export.",
      extraction_method: "none",
      text_quality: "unknown",
      contains_structured_data: false,
      structured_data_type: "none",
      page_count: null,
      sheet_names: null,
      extracted_text: null,
      structured_data: null,
      errors: [errMsg],
    };
  }
}
