import { Router, type IRouter } from "express";
import { google } from "googleapis";
import { db, usersTable, exportLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ExportEmailsBody } from "@workspace/api-zod";
import { createOAuth2Client, extractEmailParts, extractAttachments, stripHtml, decodeBase64 } from "../lib/gmail.js";
import { buildExportBundle, type EmailData, type QueryContext } from "../lib/export-formatter.js";
import { extractAttachmentContent, type ProcessingLogEntry, type AttachmentExtractionResult } from "../lib/attachment-extractor.js";

const router: IRouter = Router();

async function requireAuth(
  req: { session: unknown; log: { warn: (msg: string) => void; error: (arg: unknown, msg: string) => void } },
  res: { status: (n: number) => { json: (d: unknown) => void } },
  next: () => void
): Promise<void> {
  const session = req.session as { userId?: number };
  if (!session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

function getHeaderValue(
  headers: { name?: string | null; value?: string | null }[],
  name: string
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// POST /api/gmail/export
router.post(
  "/gmail/export",
  requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>,
  async (req, res): Promise<void> => {
    const session = req.session as { userId?: number };

    const parsed = ExportEmailsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { messageIds, queryUsed, chunkLargeBodies = false } = parsed.data;
    const searchFilters = (parsed.data as Record<string, unknown>).searchFilters as Record<string, unknown> | undefined;

    if (messageIds.length === 0) {
      res.status(400).json({ error: "No messages to export" });
      return;
    }

    if (messageIds.length > 500) {
      res.status(400).json({ error: "Cannot export more than 500 messages at once" });
      return;
    }

    try {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, session.userId!))
        .limit(1);

      if (!user || !user.accessToken) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const oauth2Client = createOAuth2Client();
      oauth2Client.setCredentials({
        access_token: user.accessToken,
        refresh_token: user.refreshToken ?? undefined,
      });

      const gmail = google.gmail({ version: "v1", auth: oauth2Client });

      const processingLog: ProcessingLogEntry[] = [];
      const emailBundles: Array<{ email: EmailData; attachments: AttachmentExtractionResult[] }> = [];

      let totalAttachmentsDetected = 0;
      let totalAttachmentsExtracted = 0;
      let totalAttachmentsFailed = 0;
      let totalAttachmentsUnsupported = 0;
      let totalEmailsWithLabel = 0;

      req.log.info({ message_count: messageIds.length }, "[export] starting bundle export");

      for (const messageId of messageIds) {
        const fetchStart = Date.now();
        processingLog.push({
          timestamp: new Date().toISOString(),
          message_id: messageId,
          attachment_id: null,
          filename: null,
          event_type: "email_fetch_started",
          status: "pending",
          extraction_method: null,
          duration_ms: null,
          error_category: null,
          error_message: null,
          user_action_needed: null,
        });

        try {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: messageId,
            format: "full",
          });

          const headers = detail.data.payload?.headers || [];
          const labelIds = detail.data.labelIds || [];
          const parts = detail.data.payload?.parts || [];
          const body = detail.data.payload?.body;

          let bodyPlainText = "";
          let bodyHtml = "";
          let bodyExtractionStatus: "success" | "partial" | "failed" = "success";
          const bodyErrors: string[] = [];

          try {
            if (parts.length > 0) {
              const extracted = extractEmailParts(parts as Parameters<typeof extractEmailParts>[0]);
              bodyPlainText = extracted.plain;
              bodyHtml = extracted.html;
            } else if (body?.data) {
              const mimeType = detail.data.payload?.mimeType || "";
              if (mimeType === "text/plain") {
                bodyPlainText = decodeBase64(body.data);
              } else if (mimeType === "text/html") {
                bodyHtml = decodeBase64(body.data);
              }
            }

            if (!bodyPlainText && !bodyHtml && !detail.data.snippet) {
              bodyExtractionStatus = "failed";
              bodyErrors.push("No body content found in message parts");
            } else if (!bodyPlainText && bodyHtml) {
              bodyExtractionStatus = "partial";
            }
          } catch (bodyErr) {
            bodyExtractionStatus = "failed";
            bodyErrors.push(bodyErr instanceof Error ? bodyErr.message : String(bodyErr));
          }

          const bodyHtmlStripped = bodyHtml ? stripHtml(bodyHtml) : "";

          // Optionally truncate large bodies
          let finalBodyPlainText = bodyPlainText;
          if (chunkLargeBodies && bodyPlainText.length > 8000) {
            finalBodyPlainText = bodyPlainText.substring(0, 8000) + "\n[...truncated for chunking]";
          }

          const headersMap: Record<string, string> = {};
          for (const h of headers) {
            if (h.name) headersMap[h.name] = h.value || "";
          }

          const email: EmailData = {
            id: detail.data.id || messageId,
            threadId: detail.data.threadId || "",
            subject: getHeaderValue(headers, "Subject") || undefined,
            from: getHeaderValue(headers, "From") || undefined,
            to: getHeaderValue(headers, "To") || undefined,
            cc: getHeaderValue(headers, "Cc") || undefined,
            bcc: getHeaderValue(headers, "Bcc") || undefined,
            replyTo: getHeaderValue(headers, "Reply-To") || undefined,
            date: getHeaderValue(headers, "Date") || undefined,
            internalDate: detail.data.internalDate || undefined,
            snippet: detail.data.snippet || undefined,
            labels: labelIds,
            bodyPlainText: finalBodyPlainText || undefined,
            bodyHtmlStripped: bodyHtmlStripped || undefined,
            htmlOriginalAvailable: !!bodyHtml,
            headers: headersMap,
            sizeEstimate: detail.data.sizeEstimate || 0,
            bodyExtractionStatus,
            bodyErrors,
          };

          processingLog.push({
            timestamp: new Date().toISOString(),
            message_id: messageId,
            attachment_id: null,
            filename: null,
            event_type: "email_fetch_completed",
            status: "success",
            extraction_method: null,
            duration_ms: Date.now() - fetchStart,
            error_category: null,
            error_message: null,
            user_action_needed: null,
          });

          // Extract attachment metadata from parts recursively
          const rawAttachmentParts = collectAttachmentParts(parts);
          const hasAttachmentLabel = labelIds.includes("HAS_ATTACHMENT");
          if (hasAttachmentLabel) totalEmailsWithLabel++;
          totalAttachmentsDetected += rawAttachmentParts.length;

          req.log.info(
            {
              message_id: messageId,
              has_attachment_label: hasAttachmentLabel,
              parts_with_filename: rawAttachmentParts.length,
              filenames: rawAttachmentParts.map((p) => p.filename).filter(Boolean),
            },
            `[export] email ${messageId}: detected ${rawAttachmentParts.length} attachment part(s)`,
          );

          if (hasAttachmentLabel && rawAttachmentParts.length === 0) {
            req.log.warn(
              { message_id: messageId },
              `[export] email ${messageId}: HAS_ATTACHMENT label set but no attachment parts found in payload`,
            );
          }

          processingLog.push(...rawAttachmentParts.map((p) => ({
            timestamp: new Date().toISOString(),
            message_id: messageId,
            attachment_id: p.body?.attachmentId || null,
            filename: p.filename || null,
            event_type: "attachment_detected",
            status: "detected",
            extraction_method: null as null,
            duration_ms: null as null,
            error_category: null as null,
            error_message: null as null,
            user_action_needed: null as null,
          })));

          // Extract content from each attachment
          const attachments: AttachmentExtractionResult[] = [];
          for (const part of rawAttachmentParts) {
            const result = await extractAttachmentContent(gmail, messageId, part, processingLog);
            attachments.push(result);
            req.log.info(
              {
                message_id: messageId,
                attachment_id: result.attachment_id,
                filename: result.filename,
                mime_type: result.mime_type,
                size_bytes: result.size_bytes,
                status: result.extraction_status,
                method: result.extraction_method,
                failure_category: result.failure_category,
              },
              `[export] attachment "${result.filename}" -> status=${result.extraction_status}${result.failure_category ? ` (${result.failure_category})` : ""}`,
            );
            if (result.extraction_status === "success") totalAttachmentsExtracted++;
            else if (result.extraction_status === "failed") totalAttachmentsFailed++;
            else if (result.extraction_status === "unsupported") totalAttachmentsUnsupported++;
          }

          processingLog.push({
            timestamp: new Date().toISOString(),
            message_id: messageId,
            attachment_id: null,
            filename: null,
            event_type: "export_record_written",
            status: "success",
            extraction_method: null,
            duration_ms: Date.now() - fetchStart,
            error_category: null,
            error_message: null,
            user_action_needed: null,
          });

          emailBundles.push({ email, attachments });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          req.log.warn(`Failed to fetch message ${messageId} for export: ${errMsg}`);
          processingLog.push({
            timestamp: new Date().toISOString(),
            message_id: messageId,
            attachment_id: null,
            filename: null,
            event_type: "email_fetch_completed",
            status: "failed",
            extraction_method: null,
            duration_ms: Date.now() - fetchStart,
            error_category: "unknown_error" as const,
            error_message: errMsg,
            user_action_needed: null,
          });
        }
      }

      const queryContext: QueryContext = {
        generated_gmail_query: queryUsed || "",
        search_filters: {
          ...(searchFilters as QueryContext["search_filters"]),
        },
      };

      const bundle = buildExportBundle(emailBundles, queryContext, processingLog);

      req.log.info(
        {
          export_id: bundle.exportId,
          emails_processed: emailBundles.length,
          emails_with_has_attachment_label: totalEmailsWithLabel,
          attachments_detected: totalAttachmentsDetected,
          attachments_extracted_success: totalAttachmentsExtracted,
          attachments_failed: totalAttachmentsFailed,
          attachments_unsupported: totalAttachmentsUnsupported,
        },
        `[export] complete: ${emailBundles.length} emails, ${totalAttachmentsDetected} attachments detected, ${totalAttachmentsExtracted} extracted, ${totalAttachmentsFailed} failed, ${totalAttachmentsUnsupported} unsupported`,
      );

      processingLog.push({
        timestamp: new Date().toISOString(),
        message_id: "",
        attachment_id: null,
        filename: null,
        event_type: "export_completed",
        status: "success",
        extraction_method: null,
        duration_ms: null,
        error_category: null,
        error_message: null,
        user_action_needed: null,
      });

      // Log the export to DB
      await db.insert(exportLogsTable).values({
        userId: session.userId!,
        exportId: bundle.exportId,
        format: "bundle",
        count: emailBundles.length,
        queryUsed: queryUsed || null,
      });

      res.json({
        exportId: bundle.exportId,
        exportedAt: bundle.exportedAt,
        format: "bundle",
        count: bundle.count,
        fullExport: bundle.fullExport,
        aiIngestion: bundle.aiIngestion,
        attachmentsIndex: bundle.attachmentsIndex,
        manifest: bundle.manifest,
        processingLog: bundle.processingLog,
      });
    } catch (err) {
      req.log.error({ err }, "Export error");
      res.status(500).json({ error: "Failed to export emails" });
    }
  }
);

// Recursively collect parts that are attachments (have filename + attachmentId)
function collectAttachmentParts(
  parts: Array<{
    partId?: string | null;
    mimeType?: string | null;
    filename?: string | null;
    body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
    headers?: { name?: string | null; value?: string | null }[] | null;
    parts?: unknown[];
  }>
): Array<{
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  body?: { attachmentId?: string | null; size?: number | null } | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
}> {
  const result: ReturnType<typeof collectAttachmentParts> = [];
  for (const part of parts) {
    if (part.filename && part.filename.length > 0) {
      result.push(part);
    }
    if (part.parts && Array.isArray(part.parts)) {
      result.push(...collectAttachmentParts(part.parts as Parameters<typeof collectAttachmentParts>[0]));
    }
  }
  return result;
}

export default router;
