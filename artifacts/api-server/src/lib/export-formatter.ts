import { v4 as uuidv4 } from "uuid";

export interface EmailData {
  id: string;
  threadId: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  date?: string;
  internalDate?: string;
  snippet?: string;
  labels?: string[];
  bodyPlainText?: string;
  bodyHtmlStripped?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; mimeType: string; size: number; attachmentId: string }[];
  sizeEstimate?: number;
}

export interface ExportOptions {
  format: "raw" | "ai-optimized" | "jsonl";
  queryUsed?: string;
  includeManifest?: boolean;
  chunkLargeBodies?: boolean;
}

export interface RawEmailExport {
  id: string;
  threadId: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  date: string | null;
  internalDate: string | null;
  snippet: string | null;
  labels: string[];
  bodyPlainText: string | null;
  bodyHtmlStripped: string | null;
  headers: Record<string, string>;
  attachmentMetadata: { filename: string; mimeType: string; size: number }[];
  queryUsed: string | null;
  exportTimestamp: string;
}

export interface AiOptimizedExport {
  document_id: string;
  source: "gmail";
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  thread_id: string;
  labels: string[];
  content: string;
  summary_stub: string;
  metadata: {
    gmail_id: string;
    has_attachments: boolean;
    attachment_count: number;
    size_estimate: number | null;
    internal_date: string | null;
    cc: string | null;
    bcc: string | null;
  };
  search_context: {
    query_used: string | null;
    export_timestamp: string;
  };
}

export interface ExportManifest {
  exportId: string;
  exportTimestamp: string;
  format: string;
  count: number;
  queryUsed: string | null;
  messageIds: string[];
}

function buildContent(email: EmailData): string {
  const parts: string[] = [];

  if (email.subject) parts.push(`Subject: ${email.subject}`);
  if (email.from) parts.push(`From: ${email.from}`);
  if (email.to) parts.push(`To: ${email.to}`);
  if (email.date) parts.push(`Date: ${email.date}`);
  if (email.labels?.length) parts.push(`Labels: ${email.labels.join(", ")}`);
  parts.push("");

  const body = email.bodyPlainText || email.bodyHtmlStripped || email.snippet || "";
  if (body) parts.push(body);

  return parts.join("\n").trim();
}

export function formatRaw(email: EmailData, queryUsed: string | null): RawEmailExport {
  const exportTimestamp = new Date().toISOString();
  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject ?? null,
    from: email.from ?? null,
    to: email.to ?? null,
    cc: email.cc ?? null,
    bcc: email.bcc ?? null,
    date: email.date ?? null,
    internalDate: email.internalDate ?? null,
    snippet: email.snippet ?? null,
    labels: email.labels ?? [],
    bodyPlainText: email.bodyPlainText ?? null,
    bodyHtmlStripped: email.bodyHtmlStripped ?? null,
    headers: email.headers ?? {},
    attachmentMetadata: (email.attachments ?? []).map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    queryUsed,
    exportTimestamp,
  };
}

export function formatAiOptimized(email: EmailData, queryUsed: string | null): AiOptimizedExport {
  const exportTimestamp = new Date().toISOString();
  const content = buildContent(email);
  const summaryStub = content.substring(0, 500);

  return {
    document_id: `gmail_${email.id}`,
    source: "gmail",
    subject: email.subject ?? null,
    from: email.from ?? null,
    to: email.to ?? null,
    date: email.date ?? null,
    thread_id: email.threadId,
    labels: email.labels ?? [],
    content,
    summary_stub: summaryStub,
    metadata: {
      gmail_id: email.id,
      has_attachments: (email.attachments?.length ?? 0) > 0,
      attachment_count: email.attachments?.length ?? 0,
      size_estimate: email.sizeEstimate ?? null,
      internal_date: email.internalDate ?? null,
      cc: email.cc ?? null,
      bcc: email.bcc ?? null,
    },
    search_context: {
      query_used: queryUsed,
      export_timestamp: exportTimestamp,
    },
  };
}

export function buildManifest(
  exportId: string,
  emails: EmailData[],
  format: string,
  queryUsed: string | null
): ExportManifest {
  return {
    exportId,
    exportTimestamp: new Date().toISOString(),
    format,
    count: emails.length,
    queryUsed,
    messageIds: emails.map((e) => e.id),
  };
}

export function exportEmails(
  emails: EmailData[],
  options: ExportOptions
): { exportId: string; data: unknown; manifest?: ExportManifest } {
  const exportId = uuidv4();
  const queryUsed = options.queryUsed ?? null;

  let data: unknown;

  switch (options.format) {
    case "raw":
      data = emails.map((e) => formatRaw(e, queryUsed));
      break;

    case "ai-optimized":
      data = emails.map((e) => formatAiOptimized(e, queryUsed));
      break;

    case "jsonl":
      data = emails.map((e) => JSON.stringify(formatAiOptimized(e, queryUsed))).join("\n");
      break;

    default:
      data = emails.map((e) => formatRaw(e, queryUsed));
  }

  const manifest = options.includeManifest
    ? buildManifest(exportId, emails, options.format, queryUsed)
    : undefined;

  return { exportId, data, manifest };
}
