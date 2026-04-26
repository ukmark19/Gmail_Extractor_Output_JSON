import { v4 as uuidv4 } from "uuid";
import type {
  AttachmentExtractionResult,
  ProcessingLogEntry,
  PageRecord,
} from "./attachment-extractor.js";

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
  document_id: string;
  source: "gmail";
  record_type: "gmail_email";
  export_version: "1.2";
  exported_at: string;
  subject: string | null;
  from: string | null;
  to: string;
  date: string | null;
  thread_id: string;
  message_id: string;
  labels: string[];
  content: string;
  summary_stub: string;
  metadata: {
    gmail_id: string;
    has_attachments: boolean;
    attachment_count: number;
    size_estimate: number;
    internal_date: string | null;
    cc: string;
    bcc: string;
  };
  attachments: AttachmentExtractionResult[];
  attachment_text_combined: string;
  search_context: QueryContext;
  body: {
    plain_text: string | null;
    html_stripped_text: string | null;
    html_original_available: boolean;
    body_extraction_status: "success" | "partial" | "failed";
    body_errors: string[];
  };
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

export interface AiIngestionRecord {
  document_id: string;
  record_type: "gmail_email_with_attachments";
  source: "gmail";
  subject: string | null;
  from: string | null;
  to: string[];
  date: string | null;
  thread_id: string;
  message_id: string;
  labels: string[];
  content: string;
  attachments_summary: Array<{
    attachment_id: string;
    filename: string;
    storage_path: string;
    sha256: string | null;
    mime_type: string;
    extraction_status: string;
    text_extracted: boolean;
    page_count: number | null;
  }>;
  attachment_text_blocks: Array<{
    /**
     * Discriminator: `attachment_text` for real extracted text;
     * `attachment_failure_notice` for synthetic notices on attachments that
     * yielded no text (failed/unsupported/skipped). Notices preserve the
     * fact that an attachment exists for the downstream LLM.
     */
    block_type: "attachment_text" | "attachment_failure_notice";
    attachment_id: string;
    filename: string;
    storage_path: string;
    mime_type: string;
    page_count: number | null;
    text: string;
  }>;
  errors: string[];
  warnings: string[];
  metadata: {
    query_used: string;
    total_attachments: number;
    extracted_attachment_count: number;
    failed_attachment_count: number;
    has_pdf: boolean;
    has_child_emails: boolean;
  };
}

export interface ValidationReport {
  validation_status: "ok" | "warnings" | "failed";
  validation_errors: string[];
  validation_warnings: string[];
  /**
   * Subset of messages that come specifically from the manifest count
   * reconciliation rules (success + partial + failed + skipped +
   * unsupported = total, supported + unsupported = total, success ≤
   * supported). Surfaced separately so `buildExportBundle` can splice
   * them into `errors_report.json` as `export_validation_error`
   * entries.
   *
   * Always present, even when empty, so consumers don't have to
   * null-check.
   */
  manifest_reconciliation_errors: string[];
}

/**
 * Test helper: predicate matching the spec rule
 * "attachment_unsupported_count = count where extraction_status ===
 * 'unsupported' OR failure_category === 'unsupported_file_type'".
 *
 * Exported so tests/callers can re-derive the same partition the
 * manifest uses.
 */
export function isUnsupportedAttachment(att: {
  extraction_status: string;
  failure_category?: string | null;
}): boolean {
  return (
    att.extraction_status === "unsupported" ||
    att.failure_category === "unsupported_file_type"
  );
}

export interface DetailedManifest {
  export_version: "1.2";
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
  /**
   * Number of attachments whose bytes were byte-identical (same sha256) to
   * an earlier attachment in this export. Their buffer is not stored a
   * second time; their index entry carries `duplicate_of`.
   */
  duplicate_attachments_count: number;
  failure_breakdown: {
    encrypted_or_password_protected: number;
    corrupt_or_malformed: number;
    unsupported_file_type: number;
    too_large: number;
    ocr_failed: number;
    ocr_not_configured: number;
    environment_error: number;
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
  validation_status: ValidationReport["validation_status"];
  validation_errors: string[];
  validation_warnings: string[];
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
  attachments: AttachmentExtractionResult[],
): string {
  const parts: string[] = [];
  parts.push(`EMAIL SUBJECT: ${email.subject || "(no subject)"}`);
  parts.push(`FROM: ${email.from || ""}`);
  parts.push(`TO: ${toArray(email.to).join(", ")}`);
  if (toArray(email.cc).length > 0)
    parts.push(`CC: ${toArray(email.cc).join(", ")}`);
  parts.push(`DATE: ${email.date || email.internalDate || ""}`);
  parts.push(`LABELS: ${(email.labels || []).join(", ")}`);
  parts.push("");
  parts.push("EMAIL BODY:");
  const body =
    email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";
  parts.push(body || "(no body content available)");

  for (const att of attachments) {
    parts.push("");
    parts.push("=".repeat(60));
    parts.push(`ATTACHMENT: ${att.filename}`);
    parts.push(`STORAGE: ${att.storage_path}`);
    parts.push(`TYPE: ${att.mime_type}`);
    parts.push(`SHA256: ${att.sha256 ?? "(none)"}`);
    parts.push(`STATUS: ${att.extraction_status}`);
    if (att.extraction_status === "success" && att.extracted_text) {
      parts.push("CONTENT:");
      parts.push(att.extracted_text);
    } else if (
      att.extraction_status === "partial" &&
      att.extracted_text
    ) {
      parts.push("CONTENT (PARTIAL):");
      parts.push(att.extracted_text);
    } else if (att.extraction_status === "unsupported") {
      parts.push(`REASON: ${att.skip_reason || "unsupported file type"}`);
    } else if (att.extraction_status === "failed") {
      parts.push(
        `REASON: ${att.failure_detail || "extraction failed"} (${att.failure_category})`,
      );
      if (att.user_action_needed)
        parts.push(`USER ACTION: ${att.user_action_needed}`);
    } else if (att.extraction_status === "skipped") {
      parts.push(`REASON: ${att.skip_reason || "skipped"}`);
    }
  }
  return parts.join("\n");
}

function buildChunks(
  email: EmailData,
  attachments: AttachmentExtractionResult[],
): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  const emailId = email.id;
  const bodyText =
    email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";
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
    if (att.extracted_text && (att.extraction_status === "success" || att.extraction_status === "partial")) {
      chunks.push({
        chunk_id: `${emailId}_att_${att.attachment_id}_001`,
        source_type: "attachment",
        source_name: att.filename,
        attachment_id: att.attachment_id,
        page_or_section: att.sheet_names ? att.sheet_names[0] || null : null,
        text: att.extracted_text,
        token_estimate: estimateTokens(att.extracted_text),
      });
    }
  }
  return chunks;
}

export function formatFullExport(
  email: EmailData,
  attachments: AttachmentExtractionResult[],
  queryContext: QueryContext,
  exportedAt: string,
): FullExportEmail {
  const toList = toArray(email.to);
  const ccList = toArray(email.cc);
  const bccList = toArray(email.bcc);
  const successCount = attachments.filter(
    (a) => a.extraction_status === "success",
  ).length;
  const failedCount = attachments.filter(
    (a) => a.extraction_status === "failed",
  ).length;
  const unsupportedCount = attachments.filter(
    (a) => a.extraction_status === "unsupported",
  ).length;
  const skippedCount = attachments.filter(
    (a) => a.extraction_status === "skipped",
  ).length;
  const allWarnings = attachments.flatMap((a) => a.warnings);
  const allErrors = attachments.flatMap((a) => a.errors);

  const combinedText = buildCombinedText(email, attachments);
  const chunks = buildChunks(email, attachments);

  const MAX = 1_000_000;
  let attachmentTextCombined = "";
  for (const att of attachments) {
    if (att.extracted_text && att.extraction_status === "success") {
      const block = `--- ${att.filename} (${att.mime_type}) [${att.storage_path}] ---\n${att.extracted_text}\n`;
      if (attachmentTextCombined.length + block.length > MAX) {
        attachmentTextCombined +=
          `--- (additional attachment text truncated) ---\n`;
        break;
      }
      attachmentTextCombined += block;
    }
  }
  const contentBody =
    email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";
  const summaryStub = contentBody.replace(/\s+/g, " ").trim().slice(0, 280);

  return {
    document_id: `gmail_${email.id}`,
    source: "gmail",
    record_type: "gmail_email",
    export_version: "1.2",
    exported_at: exportedAt,
    subject: email.subject ?? null,
    from: email.from ?? null,
    to: toList.join(", "),
    date: email.date ?? null,
    thread_id: email.threadId,
    message_id: email.id,
    labels: email.labels ?? [],
    content: contentBody,
    summary_stub: summaryStub,
    metadata: {
      gmail_id: email.id,
      has_attachments: attachments.length > 0,
      attachment_count: attachments.length,
      size_estimate: email.sizeEstimate ?? 0,
      internal_date: email.internalDate ?? null,
      cc: ccList.join(", "),
      bcc: bccList.join(", "),
    },
    attachments,
    attachment_text_combined: attachmentTextCombined,
    search_context: queryContext,
    body: {
      plain_text: email.bodyPlainText ?? null,
      html_stripped_text: email.bodyHtmlStripped ?? null,
      html_original_available: email.htmlOriginalAvailable ?? false,
      body_extraction_status: email.bodyExtractionStatus ?? "success",
      body_errors: email.bodyErrors ?? [],
    },
    content_for_ai: {
      combined_text: combinedText,
      chunking_strategy: "none",
      chunks,
    },
    processing_summary: {
      email_body_processed: !!(
        email.bodyPlainText || email.bodyHtmlStripped
      ),
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

export function formatAiIngestionRecord(
  email: EmailData,
  attachments: AttachmentExtractionResult[],
  queryContext: QueryContext,
): AiIngestionRecord {
  const toList = toArray(email.to);
  const labels = email.labels ?? [];
  const bodyText =
    email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";
  const allErrors = attachments.flatMap((a) => a.errors);
  const allWarnings = attachments.flatMap((a) => a.warnings);
  if ((email.bodyErrors ?? []).length > 0) {
    allErrors.push(...(email.bodyErrors ?? []));
  }

  const summary = attachments.map((a) => ({
    attachment_id: a.attachment_id,
    filename: a.filename,
    storage_path: a.storage_path,
    sha256: a.sha256,
    mime_type: a.mime_type,
    extraction_status: a.extraction_status,
    text_extracted: a.text_extracted,
    page_count: a.page_count,
  }));

  type AttachmentTextBlock = {
    block_type: "attachment_text" | "attachment_failure_notice";
    attachment_id: string;
    filename: string;
    storage_path: string;
    mime_type: string;
    page_count: number | null;
    text: string;
  };
  const blocks: AttachmentTextBlock[] = attachments
    .filter(
      (a) =>
        a.extracted_text &&
        (a.extraction_status === "success" ||
          a.extraction_status === "partial"),
    )
    .map((a) => ({
      block_type: "attachment_text" as const,
      attachment_id: a.attachment_id,
      filename: a.filename,
      storage_path: a.storage_path,
      mime_type: a.mime_type,
      page_count: a.page_count,
      text: a.extracted_text!,
    }));

  // For every attachment that did NOT yield text, emit a synthetic
  // "attachment_failure_notice" text block so the downstream LLM still sees
  // an explicit signal that the attachment exists and why it has no content.
  // The notice prose is human-readable and tells the LLM what happened.
  for (const a of attachments) {
    const isFailure =
      a.extraction_status === "failed" ||
      a.extraction_status === "unsupported" ||
      a.extraction_status === "skipped" ||
      ((a.extraction_status === "success" || a.extraction_status === "partial") &&
        !a.extracted_text);
    if (!isFailure) continue;
    const reason =
      a.failure_detail ||
      a.skip_reason ||
      (a.extraction_status === "unsupported"
        ? `Unsupported file type: ${a.mime_type}`
        : "No text could be extracted from this attachment.");
    const action = a.user_action_needed
      ? `\nSuggested user action: ${a.user_action_needed}`
      : "";
    const noticeText = [
      "ATTACHMENT FAILURE NOTICE",
      `Filename: ${a.filename}`,
      `MIME type: ${a.mime_type}`,
      `Status: ${a.extraction_status}`,
      `Failure category: ${a.failure_category ?? "n/a"}`,
      `Reason: ${reason}${action}`,
      "",
      "No textual content was extracted from this attachment, so it cannot be summarised or quoted. The original bytes (if downloaded) are available at the storage_path above.",
    ].join("\n");
    blocks.push({
      block_type: "attachment_failure_notice" as const,
      attachment_id: a.attachment_id,
      filename: a.filename,
      storage_path: a.storage_path,
      mime_type: a.mime_type,
      page_count: a.page_count,
      text: noticeText,
    });
  }

  return {
    document_id: `gmail_${email.id}`,
    record_type: "gmail_email_with_attachments",
    source: "gmail",
    subject: email.subject ?? null,
    from: email.from ?? null,
    to: toList,
    date: email.date ?? null,
    thread_id: email.threadId,
    message_id: email.id,
    labels,
    content: bodyText,
    attachments_summary: summary,
    attachment_text_blocks: blocks,
    errors: allErrors,
    warnings: allWarnings,
    metadata: {
      query_used: queryContext.generated_gmail_query,
      total_attachments: attachments.length,
      extracted_attachment_count: attachments.filter(
        (a) =>
          a.text_extracted &&
          (a.extraction_status === "success" ||
            a.extraction_status === "partial"),
      ).length,
      failed_attachment_count: attachments.filter(
        (a) => a.extraction_status === "failed",
      ).length,
      has_pdf: attachments.some((a) => a.mime_type === "application/pdf"),
      has_child_emails: attachments.some(
        (a) => (a.child_emails?.length ?? 0) > 0,
      ),
    },
  };
}

export function buildDetailedManifest(
  exportId: string,
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
  queryContext: QueryContext,
  exportedAt: string,
  validation: ValidationReport,
): DetailedManifest {
  let emailBodySuccess = 0;
  let emailBodyFailure = 0;
  let attachmentTotal = 0;
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
    ocr_not_configured: 0,
    environment_error: 0,
    parser_error: 0,
    network_fetch_error: 0,
    unknown_error: 0,
  };
  let duplicateCount = 0;
  const emailsWithErrors: string[] = [];
  const attachmentsRequiringAction: DetailedManifest["attachments_requiring_user_action"] =
    [];

  for (const { email, attachments } of emails) {
    const hasBody = !!(email.bodyPlainText || email.bodyHtmlStripped);
    if (hasBody) emailBodySuccess++;
    else emailBodyFailure++;
    let emailHasError = (email.bodyErrors ?? []).length > 0;

    attachmentTotal += attachments.length;
    for (const att of attachments) {
      if (att.duplicate_of) duplicateCount++;

      // Spec rules for the count buckets:
      //   - attachment_extracted_success_count = where extraction_status === "success"
      //   - attachment_partial_count           = where extraction_status === "partial"
      //   - attachment_failure_count           = where extraction_status === "failed"
      //   - attachment_skipped_count           = where extraction_status === "skipped"
      //   - attachment_unsupported_count       = where extraction_status === "unsupported"
      //                                            OR failure_category === "unsupported_file_type"
      //   - attachment_supported_count         = total − unsupported (computed once at the end)
      //
      // Each predicate is applied INDEPENDENTLY, exactly as written in
      // the spec, so a record with extraction_status="failed" AND
      // failure_category="unsupported_file_type" is intentionally
      // counted in BOTH buckets. The reconciliation pass in
      // `validateExportBundle` then catches that overlap and emits an
      // `export_validation_error` entry — surfacing the upstream data
      // inconsistency rather than silently masking it.
      switch (att.extraction_status) {
        case "success":
          attachmentSuccess++;
          break;
        case "partial":
          attachmentPartial++;
          break;
        case "failed":
          attachmentFailed++;
          emailHasError = true;
          break;
        case "skipped":
          attachmentSkipped++;
          break;
      }
      if (isUnsupportedAttachment(att)) {
        attachmentUnsupported++;
      }

      if (att.failure_category) {
        const cat = att.failure_category as keyof typeof failureBreakdown;
        if (cat in failureBreakdown) {
          failureBreakdown[cat]++;
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

  // Per spec: supported = total − unsupported. Computing it as a
  // derived value (rather than a parallel per-attachment counter)
  // makes the reconciliation rule
  // `supported + unsupported === total` hold by construction.
  const attachmentSupported = attachmentTotal - attachmentUnsupported;

  return {
    export_version: "1.2",
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
    duplicate_attachments_count: duplicateCount,
    failure_breakdown: failureBreakdown,
    emails_with_any_errors: emailsWithErrors,
    attachments_requiring_user_action: attachmentsRequiringAction,
    validation_status: validation.validation_status,
    validation_errors: validation.validation_errors,
    validation_warnings: validation.validation_warnings,
  };
}

export type ExtractionStatusLabel =
  | "success"
  | "partial"
  | "failed"
  | "unsupported"
  | "skipped";

export type DownloadStatus = "not_required" | "pending" | "success" | "failed";
export type PipelineStageStatus =
  | "not_attempted"
  | "success"
  | "failed"
  | "skipped"
  | "not_configured";

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
  size_bytes: number;
  sha256: string | null;
  original_sha256: string | null;
  processed_sha256: string | null;
  storage_path: string;
  /**
   * If this attachment's bytes are byte-identical (same sha256) to an
   * earlier attachment in the same export, this is the storage_path of the
   * first occurrence; the buffer for this entry is NOT stored a second time.
   */
  duplicate_of: string | null;
  was_downloaded: boolean;
  /** Spec-mandated coarse status for the bytes-fetch stage. */
  download_status: DownloadStatus;
  is_embedded: boolean;
  is_inline: boolean;
  attachment_role: string;
  text_extracted: boolean;
  parse_status: ExtractionStatusLabel;
  parse_method: string;
  extraction_method: string;
  failure_category: string | null;
  failure_detail: string | null;
  user_action_needed: string | null;
  page_count: number | null;
  pages_extracted_count: number | null;
  pages_failed_count: number | null;
  is_encrypted: boolean | null;
  security_removed: boolean;
  security_removal_method: string;
  security_removal_error: string | null;
  /** PDF-unlock pipeline stage (qpdf decryption). */
  pdf_unlock_attempted: boolean;
  pdf_unlock_status: PipelineStageStatus;
  /** PDF-to-images rasterisation stage (poppler/pdftoppm). */
  pdf_to_images_attempted: boolean;
  pdf_to_images_status: PipelineStageStatus;
  /** OCR stage (tesseract). */
  ocr_attempted: boolean;
  ocr_status: PipelineStageStatus;
  /**
   * Final coarse status: whether ANY text was usefully extracted, regardless
   * of which pipeline stage produced it. Mirrors parse_status but normalised
   * for downstream consumers.
   */
  final_extraction_status: ExtractionStatusLabel;
  text_summary: string;
}

/**
 * Map an AttachmentExtractionResult to the spec-mandated coarse
 * download_status: not_required (skipped before download), pending (we
 * intended to but never did), success, or failed.
 */
export function deriveDownloadStatus(
  att: AttachmentExtractionResult,
): DownloadStatus {
  if (att.was_downloaded) return "success";
  if (att.extraction_status === "skipped") return "not_required";
  if (att.extraction_status === "unsupported") return "not_required";
  if (att.extraction_status === "failed") return "failed";
  return "pending";
}

/**
 * Decide the PDF-unlock pipeline status by inspecting whether unlock was
 * attempted and the qpdf-driven unlock_status / security_removed signals.
 */
export function derivePdfUnlockStage(att: AttachmentExtractionResult): {
  attempted: boolean;
  status: PipelineStageStatus;
} {
  if (!att.unlock_attempted) {
    return { attempted: false, status: "not_attempted" };
  }
  if (att.security_removed || att.unlock_status === "success") {
    return { attempted: true, status: "success" };
  }
  if (att.unlock_status === "failed") {
    return { attempted: true, status: "failed" };
  }
  if (att.unlock_status === "skipped") {
    return { attempted: true, status: "skipped" };
  }
  return { attempted: true, status: "failed" };
}

/**
 * Decide the PDF-to-images rasterisation pipeline status from the
 * fallback_method / extraction_method signals on the result.
 */
export function derivePdfToImagesStage(att: AttachmentExtractionResult): {
  attempted: boolean;
  status: PipelineStageStatus;
} {
  // The extractor only sets fallback_method to "pdf_to_images" or "ocr"
  // (which itself rasterises via pdftoppm) when it actually went down the
  // image path.
  const wentToImages =
    att.fallback_method === "pdf_to_images" ||
    att.fallback_method === "ocr" ||
    att.extraction_method === "ocr" ||
    att.extraction_method === "pdf_parser+ocr";
  if (!wentToImages) {
    return { attempted: false, status: "not_attempted" };
  }
  if (att.failure_category === "ocr_not_configured") {
    return { attempted: true, status: "not_configured" };
  }
  if (att.fallback_used) {
    return { attempted: true, status: "success" };
  }
  return { attempted: true, status: "failed" };
}

/**
 * Decide the OCR pipeline status from extraction_method / failure_category.
 */
export function deriveOcrStage(att: AttachmentExtractionResult): {
  attempted: boolean;
  status: PipelineStageStatus;
} {
  const isImage = att.mime_type.startsWith("image/");
  const usedOcr =
    att.extraction_method === "ocr" ||
    att.extraction_method === "pdf_parser+ocr";
  if (att.failure_category === "ocr_not_configured") {
    return { attempted: true, status: "not_configured" };
  }
  if (!usedOcr && !isImage) {
    return { attempted: false, status: "not_attempted" };
  }
  if (!usedOcr && isImage) {
    // Image attachment but OCR was not run — treat as not attempted.
    return { attempted: false, status: "not_attempted" };
  }
  if (
    att.extraction_status === "success" ||
    att.extraction_status === "partial"
  ) {
    return { attempted: true, status: "success" };
  }
  return { attempted: true, status: "failed" };
}

/**
 * Walk all attachments across all emails, collapse byte-identical bytes
 * (same sha256) onto the FIRST occurrence's storage_path, and mark every
 * later occurrence with `duplicate_of`. Mutates the result records in-place
 * for simplicity (they are owned by the caller). Returns the set of
 * storage_paths that should actually be written into the ZIP.
 */
export function deduplicateAttachmentsBySha256(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
): { keepPaths: Set<string> } {
  const firstSeen = new Map<string, string>(); // sha256 -> storage_path of first occurrence
  const keepPaths = new Set<string>();
  for (const { attachments } of emails) {
    for (const att of attachments) {
      if (!att.was_downloaded || !att.sha256) continue;
      const seen = firstSeen.get(att.sha256);
      if (!seen) {
        firstSeen.set(att.sha256, att.storage_path);
        keepPaths.add(att.storage_path);
      } else {
        // duplicate — collapse onto the first occurrence's storage_path.
        att.duplicate_of = seen;
        att.storage_path = seen;
      }
    }
  }
  return { keepPaths };
}

/**
 * Build the standalone errors_report.json payload — one entry per attachment
 * that ended up failed/unsupported/skipped, grouped by failure category.
 * Consumers (humans + LLMs) use this as the single place to look for
 * "what went wrong".
 */
export interface ErrorsReportEntry {
  message_id: string;
  attachment_id: string;
  filename: string;
  mime_type: string;
  // Two name pairs are intentionally kept here:
  //   - `category` / `detail` are the long-standing field names already
  //     consumed by clients of the errors_report.json file.
  //   - `failure_category` / `failure_detail` are the explicit names called
  //     out in the spec and match the field names used inside the manifest
  //     and attachments_index for consistency. Emitting both keeps the
  //     report easy to grep without breaking older readers.
  category: string;
  failure_category: string;
  status: ExtractionStatusLabel;
  detail: string | null;
  failure_detail: string | null;
  user_action_needed: string | null;
  storage_path: string;
}

export interface ErrorsReportGroup {
  category: string;
  count: number;
  entries: ErrorsReportEntry[];
}

export function buildErrorsReport(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
): ErrorsReportGroup[] {
  const groups = new Map<string, ErrorsReportEntry[]>();
  for (const { email, attachments } of emails) {
    for (const att of attachments) {
      const isProblem =
        att.extraction_status === "failed" ||
        att.extraction_status === "unsupported" ||
        att.extraction_status === "skipped";
      if (!isProblem) continue;
      const category =
        att.failure_category ??
        (att.extraction_status === "unsupported"
          ? "unsupported_file_type"
          : att.extraction_status === "skipped"
            ? "skipped"
            : "unknown_error");
      const detail = att.failure_detail ?? att.skip_reason ?? null;
      const entry: ErrorsReportEntry = {
        message_id: email.id,
        attachment_id: att.attachment_id,
        filename: att.filename,
        mime_type: att.mime_type,
        category,
        failure_category: category,
        status: att.extraction_status,
        detail,
        failure_detail: detail,
        user_action_needed: att.user_action_needed,
        storage_path: att.storage_path,
      };
      const arr = groups.get(category);
      if (arr) arr.push(entry);
      else groups.set(category, [entry]);
    }
  }
  return Array.from(groups.entries()).map(([category, entries]) => ({
    category,
    count: entries.length,
    entries,
  }));
}

function summarizeText(text: string | null, maxChars = 240): string {
  if (!text) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxChars ? cleaned : cleaned.slice(0, maxChars) + "…";
}

export function buildAttachmentsIndex(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
): AttachmentIndexEntry[] {
  const out: AttachmentIndexEntry[] = [];
  for (const { email, attachments } of emails) {
    for (const att of attachments) {
      const unlock = derivePdfUnlockStage(att);
      const toImages = derivePdfToImagesStage(att);
      const ocr = deriveOcrStage(att);
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
        size_bytes: att.size_bytes,
        sha256: att.sha256,
        original_sha256: att.original_sha256,
        processed_sha256: att.processed_sha256,
        storage_path: att.storage_path,
        duplicate_of: att.duplicate_of,
        was_downloaded: att.was_downloaded,
        download_status: deriveDownloadStatus(att),
        is_embedded: att.is_embedded,
        is_inline: att.is_inline,
        attachment_role: att.attachment_role,
        text_extracted: att.text_extracted,
        parse_status: att.extraction_status,
        parse_method: att.extraction_method,
        extraction_method: att.extraction_method,
        failure_category: att.failure_category,
        failure_detail: att.failure_detail,
        user_action_needed: att.user_action_needed,
        page_count: att.page_count,
        pages_extracted_count: att.pages_extracted_count,
        pages_failed_count: att.pages_failed_count,
        is_encrypted: att.is_encrypted,
        security_removed: att.security_removed,
        security_removal_method: att.security_removal_method,
        security_removal_error: att.security_removal_error,
        pdf_unlock_attempted: unlock.attempted,
        pdf_unlock_status: unlock.status,
        pdf_to_images_attempted: toImages.attempted,
        pdf_to_images_status: toImages.status,
        ocr_attempted: ocr.attempted,
        ocr_status: ocr.status,
        final_extraction_status: att.extraction_status,
        text_summary: summarizeText(att.extracted_text),
      });
    }
  }
  return out;
}

/**
 * Validation pass: verifies internal consistency of the export bundle
 * before it is written to ZIP.
 */
export function validateExportBundle(
  fullExport: FullExportEmail[],
  attachmentsIndex: AttachmentIndexEntry[],
  manifest: Pick<
    DetailedManifest,
    | "attachment_count_total"
    | "attachment_supported_count"
    | "attachment_unsupported_count"
    | "attachment_extracted_success_count"
    | "attachment_partial_count"
    | "attachment_failure_count"
    | "attachment_skipped_count"
  >,
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Manifest reconciliation messages live in their own bucket so we can
  // (a) optionally demote them to warnings via env var without
  // affecting the OTHER hard invariants below, and (b) splice them
  // verbatim into errors_report.json as `export_validation_error`
  // entries.
  const reconciliation: string[] = [];
  const reconciliationMode =
    (process.env.EXPORT_MANIFEST_RECONCILIATION_MODE ?? "").trim() ===
    "warning-only"
      ? "warning-only"
      : "error";

  // 1. every attachment in full_export exists in attachments_index
  const indexById = new Map<string, AttachmentIndexEntry>();
  for (const e of attachmentsIndex) {
    indexById.set(`${e.parent_message_id}::${e.attachment_id}`, e);
  }
  for (const fe of fullExport) {
    for (const att of fe.attachments) {
      const key = `${fe.message_id}::${att.attachment_id}`;
      if (!indexById.has(key)) {
        errors.push(
          `attachment ${att.filename} (${att.attachment_id}) on email ${fe.message_id} missing from attachments_index`,
        );
      }
    }
  }

  // 2. every downloaded attachment has sha256
  for (const e of attachmentsIndex) {
    if (e.was_downloaded && !e.sha256) {
      errors.push(
        `attachment ${e.filename} on ${e.parent_message_id} downloaded but missing sha256`,
      );
    }
  }

  // 3. every storage_path is unique among NON-duplicate, downloaded entries.
  //    Duplicate entries deliberately point at the original's storage_path —
  //    that is the contract for sha256 dedup.
  const seenPaths = new Set<string>();
  for (const e of attachmentsIndex) {
    if (!e.was_downloaded) continue;
    if (e.duplicate_of) continue;
    if (seenPaths.has(e.storage_path)) {
      errors.push(`duplicate storage_path: ${e.storage_path}`);
    }
    seenPaths.add(e.storage_path);
  }

  // 4. no duplicate filename collision under same message_id at same path
  //    (duplicates are again excluded — they share a path with their original).
  const perMsg = new Map<string, Map<string, number>>();
  for (const e of attachmentsIndex) {
    if (!e.was_downloaded) continue;
    if (e.duplicate_of) continue;
    let inner = perMsg.get(e.parent_message_id);
    if (!inner) {
      inner = new Map();
      perMsg.set(e.parent_message_id, inner);
    }
    const k = e.storage_path;
    inner.set(k, (inner.get(k) ?? 0) + 1);
  }
  for (const [msg, inner] of perMsg) {
    for (const [path, count] of inner) {
      if (count > 1) {
        errors.push(`duplicate file in message ${msg}: ${path} (×${count})`);
      }
    }
  }

  // 4b. every duplicate_of points at a real storage_path that exists in the
  //     index as a non-duplicate entry.
  const allRealPaths = new Set<string>();
  for (const e of attachmentsIndex) {
    if (!e.duplicate_of) allRealPaths.add(e.storage_path);
  }
  for (const e of attachmentsIndex) {
    if (e.duplicate_of && !allRealPaths.has(e.duplicate_of)) {
      errors.push(
        `attachment ${e.filename} (${e.attachment_id}) marked duplicate_of=${e.duplicate_of} but no original entry has that storage_path`,
      );
    }
  }

  // 5. Manifest count reconciliation (spec rules). All three messages
  //    are routed through the `reconciliation` bucket so the
  //    EXPORT_MANIFEST_RECONCILIATION_MODE env var can demote them
  //    uniformly. Default behaviour: failure (export validation fails).
  //
  // 5a. supported + unsupported === total
  if (
    manifest.attachment_supported_count + manifest.attachment_unsupported_count !==
    manifest.attachment_count_total
  ) {
    reconciliation.push(
      `manifest: supported(${manifest.attachment_supported_count}) + unsupported(${manifest.attachment_unsupported_count}) != total(${manifest.attachment_count_total})`,
    );
  }
  // 5b. success + partial + failed + skipped + unsupported === total
  const reconciliationSum =
    manifest.attachment_extracted_success_count +
    manifest.attachment_partial_count +
    manifest.attachment_failure_count +
    manifest.attachment_skipped_count +
    manifest.attachment_unsupported_count;
  if (reconciliationSum !== manifest.attachment_count_total) {
    reconciliation.push(
      `manifest: status reconciliation failed — success(${manifest.attachment_extracted_success_count}) + partial(${manifest.attachment_partial_count}) + failed(${manifest.attachment_failure_count}) + skipped(${manifest.attachment_skipped_count}) + unsupported(${manifest.attachment_unsupported_count}) = ${reconciliationSum} != total(${manifest.attachment_count_total}). This typically means an attachment record has both extraction_status="failed" and failure_category="unsupported_file_type", causing it to be counted in two buckets — fix the upstream classifier so the record falls into exactly one bucket.`,
    );
  }
  // 5c. success ≤ supported  (the exact bug originally reported: 102 > 92)
  if (
    manifest.attachment_extracted_success_count >
    manifest.attachment_supported_count
  ) {
    reconciliation.push(
      `manifest: success(${manifest.attachment_extracted_success_count}) exceeds supported(${manifest.attachment_supported_count}) — supported/unsupported buckets are inconsistent with extraction_status`,
    );
  }

  // 6. every failed extraction has failure_category
  for (const e of attachmentsIndex) {
    if (e.parse_status === "failed" && !e.failure_category) {
      errors.push(
        `attachment ${e.filename} (${e.attachment_id}) failed but has no failure_category`,
      );
    }
  }

  // 7. every failed extraction has user_action_needed where appropriate
  for (const e of attachmentsIndex) {
    if (e.parse_status === "failed" && !e.user_action_needed) {
      warnings.push(
        `attachment ${e.filename} (${e.attachment_id}) failed without user_action_needed`,
      );
    }
  }

  // 8. every PDF has page_count or a clear reason
  for (const { attachments } of emails) {
    for (const att of attachments) {
      if (att.mime_type === "application/pdf") {
        if (att.page_count === null && att.extraction_status !== "skipped") {
          warnings.push(
            `PDF ${att.filename} on ${att.message_id} has no page_count (status=${att.extraction_status})`,
          );
        }
        // 9. every PDF with extracted text has page-level page records
        if (
          att.text_extracted &&
          (!att.pages || att.pages.length === 0)
        ) {
          warnings.push(
            `PDF ${att.filename} on ${att.message_id} has extracted_text but no page records`,
          );
        }
      }
    }
  }

  // Fold reconciliation messages into the appropriate bucket. In
  // "warning-only" mode (set via EXPORT_MANIFEST_RECONCILIATION_MODE)
  // the messages still appear in the report and in
  // errors_report.json, but they no longer fail validation —
  // operators can use this to ride out a partial rollout that hasn't
  // yet fixed the upstream classifier.
  if (reconciliationMode === "warning-only") {
    for (const m of reconciliation) warnings.push(m);
  } else {
    for (const m of reconciliation) errors.push(m);
  }

  let status: ValidationReport["validation_status"] = "ok";
  if (errors.length > 0) status = "failed";
  else if (warnings.length > 0) status = "warnings";

  return {
    validation_status: status,
    validation_errors: errors,
    validation_warnings: warnings,
    manifest_reconciliation_errors: reconciliation,
  };
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
  validation: ValidationReport;
  errorsReport: ErrorsReportGroup[];
  /**
   * The set of storage_paths that should actually be written into the ZIP
   * (after sha256-dedup collapses duplicates onto the first occurrence).
   * Callers should filter their attachment buffer list against this set.
   */
  keepStoragePaths: Set<string>;
}

export function buildExportBundle(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
  queryContext: QueryContext,
  processingLog: ProcessingLogEntry[],
): ExportBundle {
  const exportId = uuidv4();
  const exportedAt = new Date().toISOString();

  // CRITICAL: dedup by sha256 BEFORE building any of the downstream artifacts
  // so storage_paths in full_export, ai_ingestion, attachments_index, and
  // manifest are all consistent (duplicates point at the first occurrence).
  const { keepPaths } = deduplicateAttachmentsBySha256(emails);

  const fullExport = emails.map(({ email, attachments }) =>
    formatFullExport(email, attachments, queryContext, exportedAt),
  );
  const aiLines = emails.map(({ email, attachments }) =>
    JSON.stringify(formatAiIngestionRecord(email, attachments, queryContext)),
  );
  const aiIngestion = aiLines.join("\n");
  const attachmentsIndex = buildAttachmentsIndex(emails);
  const errorsReport = buildErrorsReport(emails);

  // Two-phase: build a tentative manifest for count fields, then validate, then re-emit final manifest
  const tentativeCounts = computeManifestCountsOnly(emails);
  const validation = validateExportBundle(
    fullExport,
    attachmentsIndex,
    tentativeCounts,
    emails,
  );

  // Per spec: when manifest reconciliation fails, surface each
  // failing rule as an `export_validation_error` entry in
  // errors_report.json so downstream consumers (humans + LLMs) see it
  // alongside the per-attachment failures. The same messages also
  // live in `validation.validation_errors` (or
  // `validation_warnings` under EXPORT_MANIFEST_RECONCILIATION_MODE
  // = "warning-only").
  if (validation.manifest_reconciliation_errors.length > 0) {
    const entries: ErrorsReportEntry[] = validation.manifest_reconciliation_errors.map(
      (msg) => ({
        message_id: "",
        attachment_id: "",
        filename: "",
        mime_type: "",
        category: "export_validation_error",
        failure_category: "export_validation_error",
        status: "failed" as ExtractionStatusLabel,
        detail: msg,
        failure_detail: msg,
        user_action_needed:
          "Fix the upstream attachment classifier so each record falls into exactly one count bucket, OR set EXPORT_MANIFEST_RECONCILIATION_MODE=warning-only to allow exports while triaging.",
        storage_path: "",
      }),
    );
    errorsReport.push({
      category: "export_validation_error",
      count: entries.length,
      entries,
    });
  }

  const manifest = buildDetailedManifest(
    exportId,
    emails,
    queryContext,
    exportedAt,
    validation,
  );

  return {
    exportId,
    exportedAt,
    count: emails.length,
    fullExport,
    aiIngestion,
    attachmentsIndex,
    manifest,
    processingLog,
    validation,
    errorsReport,
    keepStoragePaths: keepPaths,
  };
}

function computeManifestCountsOnly(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
): Pick<
  DetailedManifest,
  | "attachment_count_total"
  | "attachment_supported_count"
  | "attachment_unsupported_count"
  | "attachment_extracted_success_count"
  | "attachment_partial_count"
  | "attachment_failure_count"
  | "attachment_skipped_count"
> {
  let total = 0;
  let unsupported = 0;
  let success = 0;
  let partial = 0;
  let failed = 0;
  let skipped = 0;
  for (const { attachments } of emails) {
    total += attachments.length;
    for (const a of attachments) {
      // Apply the spec's count predicates independently — see the long
      // comment in `buildDetailedManifest` for the full rationale. The
      // two functions MUST agree on every count so the validation pass
      // can compare manifest counts against re-derived counts without
      // false positives.
      switch (a.extraction_status) {
        case "success":
          success++;
          break;
        case "partial":
          partial++;
          break;
        case "failed":
          failed++;
          break;
        case "skipped":
          skipped++;
          break;
      }
      if (isUnsupportedAttachment(a)) {
        unsupported++;
      }
    }
  }
  // supported = total − unsupported, per spec.
  const supported = total - unsupported;
  return {
    attachment_count_total: total,
    attachment_supported_count: supported,
    attachment_unsupported_count: unsupported,
    attachment_extracted_success_count: success,
    attachment_partial_count: partial,
    attachment_failure_count: failed,
    attachment_skipped_count: skipped,
  };
}

// Re-export PageRecord type for convenience
export type { PageRecord };
