import { v4 as uuidv4 } from "uuid";
import type { AttachmentExtractionResult, ProcessingLogEntry } from "./attachment-extractor.js";

export interface QueryContext {
  generated_gmail_query: string;
  search_filters: {
    keywords?: string;
    from?: string;
    to?: string;
    subject?: string;
    date_from?: string;
    date_to?: string;
    all_dates?: boolean;
    has_attachment?: boolean;
    label?: string;
    exact_phrase?: string;
    does_not_have?: string;
  };
}

export interface EmailData {
  id: string;
  threadId: string;
  subject?: string;
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  date?: string;
  internalDate?: string;
  snippet?: string;
  labels?: string[];
  bodyPlainText?: string;
  bodyHtmlStripped?: string;
  htmlOriginalAvailable?: boolean;
  headers?: Record<string, string>;
  sizeEstimate?: number;
  bodyExtractionStatus?: "success" | "partial" | "failed";
  bodyErrors?: string[];
}

export interface FullExportEmail {
  record_type: "gmail_email";
  export_version: "1.0";
  exported_at: string;
  query_context: QueryContext;
  email: {
    id: string;
    thread_id: string;
    subject: string | null;
    from: string | null;
    to: string[];
    cc: string[];
    bcc: string[];
    reply_to: string | null;
    date_header: string | null;
    internal_date: string | null;
    snippet: string | null;
    labels: string[];
    has_attachments: boolean;
    attachment_count: number;
    message_size_estimate: number;
  };
  body: {
    plain_text: string | null;
    html_stripped_text: string | null;
    html_original_available: boolean;
    body_extraction_status: "success" | "partial" | "failed";
    body_errors: string[];
  };
  attachments: AttachmentExtractionResult[];
  attachment_text_combined: string;
  content_for_ai: {
    combined_text: string;
    chunking_strategy: "none" | "page" | "heading" | "fixed";
    chunks: ContentChunk[];
  };
  processing_summary: {
    email_body_processed: boolean;
    attachments_detected: number;
    attachments_extracted_successfully: number;
    attachments_failed: number;
    attachments_unsupported: number;
    attachments_skipped: number;
    processing_warnings: string[];
    processing_errors: string[];
  };
}

export interface ContentChunk {
  chunk_id: string;
  source_type: "email_body" | "attachment";
  source_name: string;
  attachment_id: string | null;
  page_or_section: string | null;
  text: string;
  token_estimate: number;
}

export interface AiIngestionChunk {
  document_id: string;
  record_type: "gmail_ingestion_chunk";
  source: "gmail";
  source_email_id: string;
  source_thread_id: string;
  source_attachment_id: string | null;
  source_attachment_filename: string | null;
  source_component: "email_body" | "attachment";
  subject: string | null;
  from: string | null;
  to: string[];
  date: string | null;
  labels: string[];
  mime_type: string;
  chunk_index: number;
  chunk_total: number;
  text: string;
  metadata: {
    query_used: string;
    extraction_method: string;
    text_quality: string;
    page_or_sheet: string | null;
    had_extraction_error: boolean;
  };
}

export interface DetailedManifest {
  export_version: "1.0";
  exported_at: string;
  export_id: string;
  query_used: string;
  email_count: number;
  email_body_success_count: number;
  email_body_failure_count: number;
  attachment_count_total: number;
  attachment_supported_count: number;
  attachment_unsupported_count: number;
  attachment_extracted_success_count: number;
  attachment_partial_count: number;
  attachment_failure_count: number;
  attachment_skipped_count: number;
  failure_breakdown: {
    encrypted_or_password_protected: number;
    corrupt_or_malformed: number;
    unsupported_file_type: number;
    too_large: number;
    ocr_failed: number;
    parser_error: number;
    network_fetch_error: number;
    unknown_error: number;
  };
  emails_with_any_errors: string[];
  attachments_requiring_user_action: Array<{
    message_id: string;
    attachment_id: string;
    filename: string;
    reason: string;
    suggested_user_action: string;
  }>;
}

function toArray(value: string | string[] | undefined | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildCombinedText(
  email: EmailData,
  attachments: AttachmentExtractionResult[]
): string {
  const parts: string[] = [];

  parts.push(`EMAIL SUBJECT: ${email.subject || "(no subject)"}`);
  parts.push(`FROM: ${email.from || ""}`);
  parts.push(`TO: ${toArray(email.to).join(", ")}`);
  if (toArray(email.cc).length > 0) parts.push(`CC: ${toArray(email.cc).join(", ")}`);
  parts.push(`DATE: ${email.date || email.internalDate || ""}`);
  parts.push(`LABELS: ${(email.labels || []).join(", ")}`);
  parts.push("");
  parts.push("EMAIL BODY:");
  const body = email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";
  parts.push(body || "(no body content available)");

  for (const att of attachments) {
    parts.push("");
    parts.push(`${"=".repeat(60)}`);
    parts.push(`ATTACHMENT: ${att.filename}`);
    parts.push(`TYPE: ${att.mime_type}`);
    parts.push(`EXTRACTION STATUS: ${att.extraction_status}`);

    if (att.extraction_status === "success" && att.extracted_text) {
      parts.push("CONTENT:");
      parts.push(att.extracted_text);
    } else if (att.extraction_status === "unsupported") {
      parts.push(`REASON: ${att.skip_reason || "File type not supported for text extraction."}`);
      if (att.user_action_needed) parts.push(`USER ACTION: ${att.user_action_needed}`);
    } else if (att.extraction_status === "skipped") {
      parts.push(`REASON: ${att.skip_reason || "Attachment was skipped."}`);
      if (att.user_action_needed) parts.push(`USER ACTION: ${att.user_action_needed}`);
    } else if (att.extraction_status === "failed") {
      parts.push(`REASON: ${att.failure_detail || "Extraction failed."}`);
      parts.push(`FAILURE CATEGORY: ${att.failure_category || "unknown_error"}`);
      if (att.user_action_needed) parts.push(`USER ACTION: ${att.user_action_needed}`);
    } else if (att.extraction_status === "partial") {
      if (att.extracted_text) parts.push("CONTENT (PARTIAL):");
      if (att.extracted_text) parts.push(att.extracted_text);
      if (att.warnings.length > 0) parts.push(`WARNINGS: ${att.warnings.join("; ")}`);
    }
  }

  return parts.join("\n");
}

function buildChunks(
  email: EmailData,
  attachments: AttachmentExtractionResult[]
): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  const emailId = email.id;

  const bodyText = email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";
  if (bodyText) {
    chunks.push({
      chunk_id: `${emailId}_body_001`,
      source_type: "email_body",
      source_name: "body",
      attachment_id: null,
      page_or_section: null,
      text: bodyText,
      token_estimate: estimateTokens(bodyText),
    });
  }

  for (const att of attachments) {
    if (att.extraction_status === "success" && att.extracted_text) {
      const text = att.extracted_text;
      chunks.push({
        chunk_id: `${emailId}_att_${att.attachment_id}_001`,
        source_type: "attachment",
        source_name: att.filename,
        attachment_id: att.attachment_id,
        page_or_section: att.sheet_names ? att.sheet_names[0] || null : null,
        text,
        token_estimate: estimateTokens(text),
      });
    }
  }

  return chunks;
}

export function formatFullExport(
  email: EmailData,
  attachments: AttachmentExtractionResult[],
  queryContext: QueryContext,
  exportedAt: string
): FullExportEmail {
  const toList = toArray(email.to);
  const ccList = toArray(email.cc);
  const bccList = toArray(email.bcc);

  const successCount = attachments.filter((a) => a.extraction_status === "success").length;
  const failedCount = attachments.filter((a) => a.extraction_status === "failed").length;
  const unsupportedCount = attachments.filter((a) => a.extraction_status === "unsupported").length;
  const skippedCount = attachments.filter((a) => a.extraction_status === "skipped").length;

  const allWarnings: string[] = attachments.flatMap((a) => a.warnings);
  const allErrors: string[] = attachments.flatMap((a) => a.errors);

  const combinedText = buildCombinedText(email, attachments);
  const chunks = buildChunks(email, attachments);

  const MAX_COMBINED_ATT_TEXT = 1_000_000;
  let attachmentTextCombined = "";
  for (const att of attachments) {
    if (att.extraction_status === "success" && att.extracted_text) {
      const block = `--- ${att.filename} (${att.mime_type}) ---\n${att.extracted_text}\n`;
      if ((attachmentTextCombined.length + block.length) > MAX_COMBINED_ATT_TEXT) {
        attachmentTextCombined += `--- (additional attachment text truncated; full content available in attachments[].extracted_text) ---\n`;
        break;
      }
      attachmentTextCombined += block;
    }
  }

  return {
    record_type: "gmail_email",
    export_version: "1.0",
    exported_at: exportedAt,
    query_context: queryContext,
    email: {
      id: email.id,
      thread_id: email.threadId,
      subject: email.subject ?? null,
      from: email.from ?? null,
      to: toList,
      cc: ccList,
      bcc: bccList,
      reply_to: email.replyTo ?? null,
      date_header: email.date ?? null,
      internal_date: email.internalDate ?? null,
      snippet: email.snippet ?? null,
      labels: email.labels ?? [],
      has_attachments: attachments.length > 0,
      attachment_count: attachments.length,
      message_size_estimate: email.sizeEstimate ?? 0,
    },
    body: {
      plain_text: email.bodyPlainText ?? null,
      html_stripped_text: email.bodyHtmlStripped ?? null,
      html_original_available: email.htmlOriginalAvailable ?? false,
      body_extraction_status: email.bodyExtractionStatus ?? "success",
      body_errors: email.bodyErrors ?? [],
    },
    attachments,
    attachment_text_combined: attachmentTextCombined,
    content_for_ai: {
      combined_text: combinedText,
      chunking_strategy: "none",
      chunks,
    },
    processing_summary: {
      email_body_processed: !!(email.bodyPlainText || email.bodyHtmlStripped),
      attachments_detected: attachments.length,
      attachments_extracted_successfully: successCount,
      attachments_failed: failedCount,
      attachments_unsupported: unsupportedCount,
      attachments_skipped: skippedCount,
      processing_warnings: allWarnings,
      processing_errors: allErrors,
    },
  };
}

export function formatAiIngestionChunks(
  email: EmailData,
  attachments: AttachmentExtractionResult[],
  queryContext: QueryContext
): AiIngestionChunk[] {
  const chunks: AiIngestionChunk[] = [];
  const toList = toArray(email.to);
  const labels = email.labels ?? [];

  const bodyText = email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";

  if (bodyText) {
    const chunkId = `gmail_${email.id}_body_chunk_001`;
    chunks.push({
      document_id: chunkId,
      record_type: "gmail_ingestion_chunk",
      source: "gmail",
      source_email_id: email.id,
      source_thread_id: email.threadId,
      source_attachment_id: null,
      source_attachment_filename: null,
      source_component: "email_body",
      subject: email.subject ?? null,
      from: email.from ?? null,
      to: toList,
      date: email.date ?? null,
      labels,
      mime_type: "text/plain",
      chunk_index: 1,
      chunk_total: 1 + attachments.filter((a) => a.extraction_status === "success" && a.extracted_text).length,
      text: bodyText,
      metadata: {
        query_used: queryContext.generated_gmail_query,
        extraction_method: "email_body",
        text_quality: "high",
        page_or_sheet: null,
        had_extraction_error: false,
      },
    });
  }

  let chunkIndex = chunks.length + 1;
  const chunkTotal =
    (bodyText ? 1 : 0) +
    attachments.filter((a) => a.extraction_status === "success" && a.extracted_text).length;

  for (const att of attachments) {
    if (att.extraction_status === "success" && att.extracted_text) {
      chunks.push({
        document_id: `gmail_${email.id}_att_${att.attachment_id}_chunk_001`,
        record_type: "gmail_ingestion_chunk",
        source: "gmail",
        source_email_id: email.id,
        source_thread_id: email.threadId,
        source_attachment_id: att.attachment_id,
        source_attachment_filename: att.filename,
        source_component: "attachment",
        subject: email.subject ?? null,
        from: email.from ?? null,
        to: toList,
        date: email.date ?? null,
        labels,
        mime_type: att.mime_type,
        chunk_index: chunkIndex++,
        chunk_total: chunkTotal,
        text: att.extracted_text,
        metadata: {
          query_used: queryContext.generated_gmail_query,
          extraction_method: att.extraction_method,
          text_quality: att.text_quality,
          page_or_sheet: att.sheet_names ? att.sheet_names[0] || null : null,
          had_extraction_error: att.errors.length > 0,
        },
      });
    }
  }

  return chunks;
}

export function buildDetailedManifest(
  exportId: string,
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
  queryContext: QueryContext,
  exportedAt: string
): DetailedManifest {
  let emailBodySuccess = 0;
  let emailBodyFailure = 0;
  let attachmentTotal = 0;
  let attachmentSupported = 0;
  let attachmentUnsupported = 0;
  let attachmentSuccess = 0;
  let attachmentPartial = 0;
  let attachmentFailed = 0;
  let attachmentSkipped = 0;
  const failureBreakdown = {
    encrypted_or_password_protected: 0,
    corrupt_or_malformed: 0,
    unsupported_file_type: 0,
    too_large: 0,
    ocr_failed: 0,
    parser_error: 0,
    network_fetch_error: 0,
    unknown_error: 0,
  };
  const emailsWithErrors: string[] = [];
  const attachmentsRequiringAction: DetailedManifest["attachments_requiring_user_action"] = [];

  for (const { email, attachments } of emails) {
    const hasBody = !!(email.bodyPlainText || email.bodyHtmlStripped);
    if (hasBody) emailBodySuccess++;
    else emailBodyFailure++;

    let emailHasError = (email.bodyErrors ?? []).length > 0;

    attachmentTotal += attachments.length;
    for (const att of attachments) {
      if (att.is_supported) attachmentSupported++;
      else attachmentUnsupported++;

      if (att.extraction_status === "success") attachmentSuccess++;
      else if (att.extraction_status === "partial") attachmentPartial++;
      else if (att.extraction_status === "failed") {
        attachmentFailed++;
        emailHasError = true;
      }
      else if (att.extraction_status === "skipped") attachmentSkipped++;
      else if (att.extraction_status === "unsupported") attachmentUnsupported++;

      if (att.failure_category) {
        const cat = att.failure_category;
        if (cat in failureBreakdown) {
          (failureBreakdown as Record<string, number>)[cat]++;
        } else {
          failureBreakdown.unknown_error++;
        }
      }

      if (att.user_action_needed) {
        attachmentsRequiringAction.push({
          message_id: email.id,
          attachment_id: att.attachment_id,
          filename: att.filename,
          reason: att.failure_detail || att.skip_reason || att.user_action_needed,
          suggested_user_action: att.user_action_needed,
        });
      }
    }

    if (emailHasError) emailsWithErrors.push(email.id);
  }

  return {
    export_version: "1.0",
    exported_at: exportedAt,
    export_id: exportId,
    query_used: queryContext.generated_gmail_query,
    email_count: emails.length,
    email_body_success_count: emailBodySuccess,
    email_body_failure_count: emailBodyFailure,
    attachment_count_total: attachmentTotal,
    attachment_supported_count: attachmentSupported,
    attachment_unsupported_count: attachmentUnsupported,
    attachment_extracted_success_count: attachmentSuccess,
    attachment_partial_count: attachmentPartial,
    attachment_failure_count: attachmentFailed,
    attachment_skipped_count: attachmentSkipped,
    failure_breakdown: failureBreakdown,
    emails_with_any_errors: emailsWithErrors,
    attachments_requiring_user_action: attachmentsRequiringAction,
  };
}

export interface AttachmentIndexEntry {
  attachment_id: string;
  parent_document_id: string;
  parent_message_id: string;
  parent_subject: string | null;
  parent_from: string | null;
  parent_date: string | null;
  filename: string;
  safe_filename: string;
  content_type: string;
  extension: string;
  size: number;
  sha256: string | null;
  storage_path: string;
  is_embedded: boolean;
  text_extracted: boolean;
  parse_status: ExtractionStatusLabel;
  parse_method: string;
  failure_category: string | null;
  text_summary: string;
}

export type ExtractionStatusLabel = "success" | "partial" | "failed" | "unsupported" | "skipped";

function summarizeText(text: string | null, maxChars = 240): string {
  if (!text) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxChars ? cleaned : cleaned.slice(0, maxChars) + "…";
}

export function buildAttachmentsIndex(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>
): AttachmentIndexEntry[] {
  const out: AttachmentIndexEntry[] = [];
  for (const { email, attachments } of emails) {
    for (const att of attachments) {
      out.push({
        attachment_id: att.attachment_id,
        parent_document_id: att.parent_document_id,
        parent_message_id: email.id,
        parent_subject: email.subject ?? null,
        parent_from: email.from ?? null,
        parent_date: email.date ?? email.internalDate ?? null,
        filename: att.filename,
        safe_filename: att.safe_filename,
        content_type: att.mime_type,
        extension: att.file_extension,
        size: att.size_bytes,
        sha256: att.sha256,
        storage_path: att.storage_path,
        is_embedded: att.is_embedded,
        text_extracted: att.extraction_status === "success" && !!att.extracted_text,
        parse_status: att.extraction_status,
        parse_method: att.extraction_method,
        failure_category: att.failure_category,
        text_summary: summarizeText(att.extracted_text),
      });
    }
  }
  return out;
}

export interface ExportBundle {
  exportId: string;
  exportedAt: string;
  count: number;
  fullExport: FullExportEmail[];
  aiIngestion: string;
  attachmentsIndex: AttachmentIndexEntry[];
  manifest: DetailedManifest;
  processingLog: ProcessingLogEntry[];
}

export function buildExportBundle(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
  queryContext: QueryContext,
  processingLog: ProcessingLogEntry[]
): ExportBundle {
  const exportId = uuidv4();
  const exportedAt = new Date().toISOString();

  const fullExport: FullExportEmail[] = emails.map(({ email, attachments }) =>
    formatFullExport(email, attachments, queryContext, exportedAt)
  );

  const aiIngestionLines: string[] = emails.flatMap(({ email, attachments }) =>
    formatAiIngestionChunks(email, attachments, queryContext).map((chunk) =>
      JSON.stringify(chunk)
    )
  );
  const aiIngestion = aiIngestionLines.join("\n");

  const manifest = buildDetailedManifest(exportId, emails, queryContext, exportedAt);
  const attachmentsIndex = buildAttachmentsIndex(emails);

  return {
    exportId,
    exportedAt,
    count: emails.length,
    fullExport,
    aiIngestion,
    attachmentsIndex,
    manifest,
    processingLog,
  };
}
