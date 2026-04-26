import { v4 as uuidv4 } from "uuid";
import type {
  AttachmentExtractionResult,
  ProcessingLogEntry,
  PageRecord,
} from "./attachment-extractor.js";
import {
  buildAttachmentsIndex,
  buildDetailedManifest as buildBaseDetailedManifest,
  buildErrorsReport as buildBaseErrorsReport,
  deduplicateAttachmentsBySha256,
  deriveDownloadStatus,
  deriveOcrStage,
  derivePdfToImagesStage,
  derivePdfUnlockStage,
  formatAiIngestionRecord,
  formatFullExport,
  validateExportBundle as validateBaseExportBundle,
} from "./export-formatter-base.js";
import type {
  AiIngestionRecord,
  AttachmentIndexEntry,
  ContentChunk,
  DetailedManifest,
  DownloadStatus,
  EmailData,
  ExtractionStatusLabel,
  FullExportEmail,
  PipelineStageStatus,
  QueryContext,
  ValidationReport,
} from "./export-formatter-base.js";

export {
  buildAttachmentsIndex,
  deduplicateAttachmentsBySha256,
  deriveDownloadStatus,
  deriveOcrStage,
  derivePdfToImagesStage,
  derivePdfUnlockStage,
  formatAiIngestionRecord,
  formatFullExport,
};

export type {
  AiIngestionRecord,
  AttachmentIndexEntry,
  ContentChunk,
  DetailedManifest,
  DownloadStatus,
  EmailData,
  ExtractionStatusLabel,
  FullExportEmail,
  PageRecord,
  PipelineStageStatus,
  QueryContext,
  ValidationReport,
};

function isUnsupportedForManifest(att: AttachmentExtractionResult): boolean {
  return (
    att.extraction_status === "unsupported" ||
    att.failure_category === "unsupported_file_type"
  );
}

function isManifestReconciliationWarningOnly(): boolean {
  return (
    process.env.EXPORT_MANIFEST_RECONCILIATION_MODE?.toLowerCase() ===
    "warning-only"
  );
}

function isManifestReconciliationProblem(message: string): boolean {
  return message.startsWith("manifest:");
}

export interface ErrorsReportEntry {
  message_id: string;
  attachment_id: string;
  filename: string;
  mime_type: string;
  category: string;
  failure_category: string;
  status: ExtractionStatusLabel | "validation_error";
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
  keepStoragePaths: Set<string>;
}

export function buildDetailedManifest(
  exportId: string,
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
  queryContext: QueryContext,
  exportedAt: string,
  validation: ValidationReport,
): DetailedManifest {
  const manifest = buildBaseDetailedManifest(
    exportId,
    emails,
    queryContext,
    exportedAt,
    validation,
  );
  return {
    ...manifest,
    ...computeManifestCountsOnly(emails),
  };
}

export function buildErrorsReport(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
  validation?: ValidationReport,
): ErrorsReportGroup[] {
  const groups = buildBaseErrorsReport(emails) as ErrorsReportGroup[];
  if (!validation || validation.validation_errors.length === 0) {
    return groups;
  }

  return [
    ...groups.filter((group) => group.category !== "export_validation_error"),
    {
      category: "export_validation_error",
      count: validation.validation_errors.length,
      entries: validation.validation_errors.map((detail, index) => ({
        message_id: "",
        attachment_id: `export_validation_error_${index + 1}`,
        filename: "export_manifest.json",
        mime_type: "application/json",
        category: "export_validation_error",
        failure_category: "export_validation_error",
        status: "validation_error",
        detail,
        failure_detail: detail,
        user_action_needed:
          "Fix manifest attachment status counts before trusting this export.",
        storage_path: "export_manifest.json",
      })),
    },
  ];
}

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
  const report = validateBaseExportBundle(
    fullExport,
    attachmentsIndex,
    manifest,
    emails,
  );
  if (!isManifestReconciliationWarningOnly()) return report;

  const reconciliationErrors = report.validation_errors.filter(
    isManifestReconciliationProblem,
  );
  if (reconciliationErrors.length === 0) return report;

  const validationErrors = report.validation_errors.filter(
    (error) => !isManifestReconciliationProblem(error),
  );
  const validationWarnings = [
    ...report.validation_warnings,
    ...reconciliationErrors,
  ];
  return {
    validation_status:
      validationErrors.length > 0
        ? "failed"
        : validationWarnings.length > 0
          ? "warnings"
          : "ok",
    validation_errors: validationErrors,
    validation_warnings: validationWarnings,
  };
}

export function buildExportBundle(
  emails: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }>,
  queryContext: QueryContext,
  processingLog: ProcessingLogEntry[],
): ExportBundle {
  const exportId = uuidv4();
  const exportedAt = new Date().toISOString();
  const { keepPaths } = deduplicateAttachmentsBySha256(emails);

  const fullExport = emails.map(({ email, attachments }) =>
    formatFullExport(email, attachments, queryContext, exportedAt),
  );
  const aiLines = emails.map(({ email, attachments }) =>
    JSON.stringify(formatAiIngestionRecord(email, attachments, queryContext)),
  );
  const aiIngestion = aiLines.join("\n");
  const attachmentsIndex = buildAttachmentsIndex(emails);

  const tentativeCounts = computeManifestCountsOnly(emails);
  const validation = validateExportBundle(
    fullExport,
    attachmentsIndex,
    tentativeCounts,
    emails,
  );
  const manifest = buildDetailedManifest(
    exportId,
    emails,
    queryContext,
    exportedAt,
    validation,
  );
  const errorsReport = buildErrorsReport(emails, validation);

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
    for (const attachment of attachments) {
      if (isUnsupportedForManifest(attachment)) unsupported++;

      switch (attachment.extraction_status) {
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
        case "unsupported":
          break;
      }
    }
  }

  return {
    attachment_count_total: total,
    attachment_supported_count: total - unsupported,
    attachment_unsupported_count: unsupported,
    attachment_extracted_success_count: success,
    attachment_partial_count: partial,
    attachment_failure_count: failed,
    attachment_skipped_count: skipped,
  };
}
