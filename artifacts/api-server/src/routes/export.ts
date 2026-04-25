import { Router, type IRouter } from "express";
import { google } from "googleapis";
import { db, usersTable, exportLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ExportEmailsBody } from "@workspace/api-zod";
import {
  createOAuth2Client,
  extractEmailParts,
  stripHtml,
  decodeBase64,
} from "../lib/gmail.js";
import {
  buildExportBundle,
  type EmailData,
  type QueryContext,
} from "../lib/export-formatter.js";
import {
  extractAttachmentContent,
  buildStoragePath,
  type ProcessingLogEntry,
  type AttachmentExtractionResult,
} from "../lib/attachment-extractor.js";
import {
  streamExportZipWithDiskTee,
  type AttachmentBufferEntry,
  type OcrImageEntry,
  type SerializedBundleEntries,
} from "../lib/export-zip.js";
import { SafeJsonError, serializeJsonSafe } from "../lib/safe-json.js";
import { createReadStream, existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const router: IRouter = Router();

/**
 * Root directory on disk where every export is persisted. Exports are scoped
 * by user id to prevent one user from re-downloading another user's most
 * recent export through the /api/gmail/export/latest endpoint:
 *   exports/users/<userId>/export_<ts>/<filename>.zip   — immutable per-user copy
 *   exports/users/<userId>/latest/latest.zip            — per-user "latest"
 * Resolved relative to process cwd (the api-server package root in dev).
 */
const EXPORTS_ROOT = resolve(process.cwd(), "exports");

function userExportsRoot(userId: number): string {
  return join(EXPORTS_ROOT, "users", String(userId));
}

function userLatestZipPath(userId: number): string {
  return join(userExportsRoot(userId), "latest", "latest.zip");
}

async function requireAuth(
  req: {
    session: unknown;
    log: { warn: (msg: string) => void; error: (arg: unknown, msg: string) => void };
  },
  res: { status: (n: number) => { json: (d: unknown) => void } },
  next: () => void,
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
  name: string,
): string {
  return (
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

function makeLog(
  messageId: string,
  attachmentId: string | null,
  filename: string | null,
  event_type: string,
  status: string,
  extra: Partial<ProcessingLogEntry> = {},
): ProcessingLogEntry {
  return {
    timestamp: new Date().toISOString(),
    message_id: messageId,
    attachment_id: attachmentId,
    filename,
    event_type,
    status,
    extraction_method: null,
    duration_ms: null,
    error_category: null,
    error_message: null,
    user_action_needed: null,
    ...extra,
  };
}

// POST /api/gmail/export — streams a ZIP bundle (and persists to disk)
router.post(
  "/gmail/export",
  requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>,
  async (req, res): Promise<void> => {
    const session = req.session as { userId?: number };
    const exportStart = Date.now();
    // Diagnostics buffer that grows BEFORE the validated payload is even
    // available, so we can attribute parse failures to a specific request.
    const processingLog: ProcessingLogEntry[] = [];

    // Snapshot of the raw payload shape (NEVER include actual ids in logs in
    // production-leaning detail; we log lengths + types so the user can
    // diagnose "0 emails exported" without spilling message ids to disk).
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const rawMsgIds = Array.isArray(rawBody.messageIds)
      ? (rawBody.messageIds as unknown[])
      : [];
    const payloadDigest = {
      selectedMessageIds_count: rawMsgIds.length,
      selectedMessageIds_sample: rawMsgIds.slice(0, 3),
      query: typeof rawBody.queryUsed === "string" ? rawBody.queryUsed : null,
      exportMode:
        rawBody.exportAllResults === true ? "all_matching" : "selected",
      includeAttachments: true, // currently always true; reserved for future toggle
      resultCount: rawMsgIds.length,
      hasSearchFilters: !!rawBody.searchFilters,
      maxResults:
        typeof rawBody.maxResults === "number" ? rawBody.maxResults : 500,
      includeSpamTrash: rawBody.includeSpamTrash === true,
    };
    req.log.info(
      { ...payloadDigest, user_id: session.userId },
      "[export] export_requested — raw payload received",
    );
    processingLog.push(
      makeLog("", null, null, "export_requested", "received", {
        error_message: JSON.stringify({
          user_id: session.userId,
          ...payloadDigest,
        }),
      }),
    );

    const parsed = ExportEmailsBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn(
        { issues: parsed.error.format() },
        "[export] payload failed schema validation",
      );
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const {
      messageIds: bodyMessageIds,
      queryUsed,
      chunkLargeBodies = false,
    } = parsed.data;
    const exportAllResults = (parsed.data as Record<string, unknown>)
      .exportAllResults === true;
    const requestedMaxResults = Math.max(
      1,
      Math.min(
        500,
        Number(
          (parsed.data as Record<string, unknown>).maxResults ?? 500,
        ) || 500,
      ),
    );
    const includeSpamTrash =
      (parsed.data as Record<string, unknown>).includeSpamTrash === true;
    const searchFilters = (parsed.data as Record<string, unknown>)
      .searchFilters as Record<string, unknown> | undefined;

    processingLog.push(
      makeLog("", null, null, "export_payload_received", "ok", {
        error_message: JSON.stringify({
          messageIds_count: bodyMessageIds.length,
          exportAllResults,
          queryUsed: queryUsed ?? null,
          maxResults: requestedMaxResults,
          includeSpamTrash,
        }),
      }),
    );

    // Hard cap on explicitly-selected ids
    if (bodyMessageIds.length > 500) {
      res
        .status(400)
        .json({ error: "Cannot export more than 500 messages at once" });
      return;
    }

    // Resolve the FINAL set of messageIds we'll export. Three branches:
    //   1. Explicit selection wins (most predictable for the user).
    //   2. Else exportAllResults + non-empty queryUsed → re-run Gmail
    //      search server-side and use those ids.
    //   3. Else hard-fail with a clear message — never silently produce
    //      an empty export.
    let messageIds: string[] = bodyMessageIds;
    let resolutionMode: "selected" | "all_matching" = "selected";

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

      if (messageIds.length === 0) {
        if (exportAllResults && queryUsed && queryUsed.trim().length > 0) {
          resolutionMode = "all_matching";
          req.log.info(
            { query: queryUsed, max: requestedMaxResults, includeSpamTrash },
            "[export] no message ids supplied — re-running Gmail query server-side",
          );
          processingLog.push(
            makeLog("", null, null, "export_query_used", "rerun", {
              error_message: JSON.stringify({
                query: queryUsed,
                maxResults: requestedMaxResults,
                includeSpamTrash,
              }),
            }),
          );
          const collected: string[] = [];
          let pageToken: string | undefined;
          let pages = 0;
          // Re-page through Gmail until we hit requestedMaxResults or run out.
          // Gmail caps each page at ~500; we still respect the per-export 500.
          while (collected.length < requestedMaxResults && pages < 10) {
            const pageSize = Math.min(
              500,
              requestedMaxResults - collected.length,
            );
            const r = await gmail.users.messages.list({
              userId: "me",
              q: queryUsed,
              maxResults: pageSize,
              pageToken,
              includeSpamTrash,
            });
            const ids = (r.data.messages || [])
              .map((m) => m.id || "")
              .filter(Boolean);
            collected.push(...ids);
            pageToken = r.data.nextPageToken || undefined;
            pages += 1;
            if (!pageToken) break;
          }
          messageIds = collected.slice(0, requestedMaxResults);
          req.log.info(
            { resolved_count: messageIds.length, pages_fetched: pages },
            "[export] server-side re-fetch resolved message ids",
          );
        } else {
          // Final guard: never silently emit a 0-email export. Emit the
          // required diagnostic events on this failure exit too so anyone
          // tailing the processing log sees the same six event names.
          processingLog.push(
            makeLog("", null, null, "export_message_ids_count", "failed", {
              error_category: "no_selection",
              error_message: JSON.stringify({ count: 0, mode: "none" }),
            }),
          );
          processingLog.push(
            makeLog("", null, null, "export_query_used", "skipped", {
              error_message: JSON.stringify({ query: queryUsed ?? "" }),
            }),
          );
          processingLog.push(
            makeLog("", null, null, "export_completed", "failed", {
              duration_ms: Date.now() - exportStart,
              error_category: "no_selection",
              error_message:
                "No messageIds and no exportAllResults+queryUsed flag.",
            }),
          );
          res.status(400).json({
            error:
              "No emails selected for export. Either pick at least one message or set exportAllResults=true with a non-empty queryUsed.",
            processingLog,
          });
          return;
        }
      }

      processingLog.push(
        makeLog("", null, null, "export_message_ids_count", "ok", {
          error_message: JSON.stringify({
            count: messageIds.length,
            mode: resolutionMode,
          }),
        }),
      );
      // Always emit `export_query_used` so the event sequence is consistent
      // across runs. When no query was used (pure selection), we record an
      // empty query string with a "none" status — that tells a future
      // debugger that the absence was intentional, not dropped logging.
      processingLog.push(
        makeLog(
          "",
          null,
          null,
          "export_query_used",
          queryUsed ? "ok" : "none",
          {
            error_message: JSON.stringify({ query: queryUsed ?? "" }),
          },
        ),
      );

      if (messageIds.length === 0) {
        // Could happen if "all matching" returned zero from Gmail.
        processingLog.push(
          makeLog("", null, null, "export_messages_loaded_count", "failed", {
            error_category: "no_results",
            error_message: JSON.stringify({
              requested: 0,
              loaded: 0,
              missing: 0,
              mode: resolutionMode,
            }),
          }),
        );
        processingLog.push(
          makeLog("", null, null, "export_completed", "failed", {
            duration_ms: Date.now() - exportStart,
            error_category: "no_results",
            error_message: "Gmail returned 0 messages for queryUsed.",
          }),
        );
        res.status(400).json({
          error:
            "Gmail returned 0 messages for this query. Refine the search and try again.",
          processingLog,
        });
        return;
      }

      const emailBundles: Array<{
        email: EmailData;
        attachments: AttachmentExtractionResult[];
      }> = [];
      // Buffers indexed by their PRE-DEDUP storage_path. We filter against
      // bundle.keepStoragePaths after dedup before streaming.
      const attachmentBuffers: AttachmentBufferEntry[] = [];
      const ocrImages: OcrImageEntry[] = [];

      let totalAttachmentsDetected = 0;
      let totalAttachmentsExtracted = 0;
      let totalAttachmentsFailed = 0;
      let totalAttachmentsUnsupported = 0;
      let totalEmailsWithLabel = 0;

      req.log.info(
        {
          message_count: messageIds.length,
          mode: resolutionMode,
          user_id: session.userId,
        },
        "[export] starting bundle export",
      );

      for (const messageId of messageIds) {
        const fetchStart = Date.now();
        processingLog.push(
          makeLog(messageId, null, null, "email_fetch_started", "pending"),
        );

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
              const extracted = extractEmailParts(
                parts as Parameters<typeof extractEmailParts>[0],
              );
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
            bodyErrors.push(
              bodyErr instanceof Error ? bodyErr.message : String(bodyErr),
            );
          }

          const bodyHtmlStripped = bodyHtml ? stripHtml(bodyHtml) : "";

          // Optionally truncate large bodies
          let finalBodyPlainText = bodyPlainText;
          if (chunkLargeBodies && bodyPlainText.length > 8000) {
            finalBodyPlainText =
              bodyPlainText.substring(0, 8000) + "\n[...truncated for chunking]";
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

          processingLog.push(
            makeLog(messageId, null, null, "email_fetch_completed", "success", {
              duration_ms: Date.now() - fetchStart,
            }),
          );

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

          processingLog.push(
            ...rawAttachmentParts.map((p) =>
              makeLog(
                messageId,
                p.body?.attachmentId || null,
                p.filename || null,
                "attachment_detected",
                "detected",
              ),
            ),
          );

          // Extract content from each attachment
          const attachments: AttachmentExtractionResult[] = [];
          for (let idx = 0; idx < rawAttachmentParts.length; idx++) {
            const part = rawAttachmentParts[idx];
            const isPdf =
              (part.mimeType || "").toLowerCase() === "application/pdf";

            if (isPdf) {
              processingLog.push(
                makeLog(
                  messageId,
                  part.body?.attachmentId || null,
                  part.filename || null,
                  "pdf_security_analysis_started",
                  "pending",
                  { extraction_method: "pdf_parser" },
                ),
              );
            }

            const extracted = await extractAttachmentContent(
              gmail,
              messageId,
              part,
              processingLog,
            );
            const result = extracted.result;

            if (isPdf) {
              processingLog.push(
                makeLog(
                  messageId,
                  result.attachment_id,
                  result.filename,
                  "pdf_security_analysis_completed",
                  result.is_encrypted ? "encrypted" : "clear",
                  {
                    extraction_method: "pdf_parser",
                  },
                ),
              );
            }

            // Synthesize per-stage events from the result + presence of OCR
            // page images so the processing_log surfaces the new stages
            // without requiring extractor-internal changes per call site.
            if (result.fallback_method === "pdf_to_images" || result.extraction_method === "ocr" || result.extraction_method === "pdf_parser+ocr") {
              processingLog.push(
                makeLog(
                  messageId,
                  result.attachment_id,
                  result.filename,
                  "pdf_to_images_started",
                  "pending",
                ),
              );
              processingLog.push(
                makeLog(
                  messageId,
                  result.attachment_id,
                  result.filename,
                  "pdf_to_images_completed",
                  result.failure_category === "ocr_not_configured"
                    ? "not_configured"
                    : extracted.ocrPageImages && extracted.ocrPageImages.length > 0
                      ? "success"
                      : "failed",
                ),
              );
            }
            if (
              result.extraction_method === "ocr" ||
              result.extraction_method === "pdf_parser+ocr"
            ) {
              processingLog.push(
                makeLog(
                  messageId,
                  result.attachment_id,
                  result.filename,
                  "ocr_started",
                  "pending",
                  { extraction_method: "ocr" },
                ),
              );
              processingLog.push(
                makeLog(
                  messageId,
                  result.attachment_id,
                  result.filename,
                  "ocr_completed",
                  result.extraction_status === "success" ||
                    result.extraction_status === "partial"
                    ? "success"
                    : "failed",
                  {
                    extraction_method: "ocr",
                    error_category: result.failure_category,
                  },
                ),
              );
            }

            // Pick the bytes that will actually live in the ZIP and derive the
            // sha256 used in the storage path from those exact bytes so the
            // filename's sha8 is always consistent with the stored payload.
            const bufToStore = extracted.processedBuffer ?? extracted.buffer;
            if (bufToStore && result.was_downloaded) {
              const storedSha =
                extracted.processedBuffer && result.processed_sha256
                  ? result.processed_sha256
                  : result.original_sha256 ?? result.sha256;
              // sha256 is the canonical "what's in the ZIP" hash
              result.sha256 = storedSha;
              result.storage_path = buildStoragePath(
                messageId,
                idx,
                storedSha,
                result.safe_filename,
              );
              attachmentBuffers.push({
                storagePath: result.storage_path,
                buffer: bufToStore,
              });
            } else {
              // Not stored: still build a deterministic path for the index
              result.storage_path = buildStoragePath(
                messageId,
                idx,
                result.sha256,
                result.safe_filename,
              );
            }

            // Surface OCR page PNGs into the export ZIP under
            // ocr_images/<msgId>/<attId>/page_<n>.png
            if (extracted.ocrPageImages && extracted.ocrPageImages.length > 0) {
              for (const p of extracted.ocrPageImages) {
                ocrImages.push({
                  messageId,
                  attachmentId: result.attachment_id,
                  pageNumber: p.pageNumber,
                  png: p.png,
                });
              }
            }

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
                storage_path: result.storage_path,
                security_removed: result.security_removed,
              },
              `[export] attachment "${result.filename}" -> status=${result.extraction_status}${
                result.failure_category ? ` (${result.failure_category})` : ""
              }`,
            );
            if (result.extraction_status === "success") totalAttachmentsExtracted++;
            else if (result.extraction_status === "failed") totalAttachmentsFailed++;
            else if (result.extraction_status === "unsupported")
              totalAttachmentsUnsupported++;
          }

          processingLog.push(
            makeLog(messageId, null, null, "export_record_written", "success", {
              duration_ms: Date.now() - fetchStart,
            }),
          );

          emailBundles.push({ email, attachments });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          req.log.warn(`Failed to fetch message ${messageId} for export: ${errMsg}`);
          processingLog.push(
            makeLog(messageId, null, null, "email_fetch_completed", "failed", {
              duration_ms: Date.now() - fetchStart,
              error_category: "unknown_error",
              error_message: errMsg,
            }),
          );
        }
      }

      // Hard guard against the "silent 0-email ZIP" failure mode: if every
      // single message fetch failed (network, revoked token, deleted msg,
      // etc.) we still have a non-empty `messageIds` resolution but
      // `emailBundles` is empty. Don't build a bundle the user can't use —
      // surface the failure clearly with the same diagnostic events.
      if (emailBundles.length === 0) {
        processingLog.push(
          makeLog("", null, null, "export_messages_loaded_count", "failed", {
            error_category: "all_fetches_failed",
            error_message: JSON.stringify({
              requested: messageIds.length,
              loaded: 0,
              missing: messageIds.length,
              mode: resolutionMode,
            }),
          }),
        );
        processingLog.push(
          makeLog("", null, null, "export_completed", "failed", {
            duration_ms: Date.now() - exportStart,
            error_category: "all_fetches_failed",
            error_message:
              "All Gmail message fetches failed; no emails could be exported.",
          }),
        );
        req.log.error(
          { requested: messageIds.length, mode: resolutionMode },
          "[export] every per-message fetch failed; refusing to write empty ZIP",
        );
        res.status(502).json({
          error:
            "Could not load any of the requested emails from Gmail. Try again, or refine the selection.",
          processingLog,
        });
        return;
      }

      const queryContext: QueryContext = {
        generated_gmail_query: queryUsed || "",
        search_filters: {
          ...(searchFilters as QueryContext["search_filters"]),
        },
      };

      const bundle = buildExportBundle(
        emailBundles,
        queryContext,
        processingLog,
      );

      // After dedup, only keep buffers whose storage_path survived. The first
      // occurrence of any (sha256) wins; later occurrences had their
      // storage_path collapsed onto the first by the bundle builder.
      const uniqueByPath = new Map<string, AttachmentBufferEntry>();
      for (const b of attachmentBuffers) {
        if (!bundle.keepStoragePaths.has(b.storagePath)) continue;
        if (!uniqueByPath.has(b.storagePath)) {
          uniqueByPath.set(b.storagePath, b);
        }
      }
      const dedupedBuffers = Array.from(uniqueByPath.values());

      processingLog.push(
        makeLog(
          "",
          null,
          null,
          "export_messages_loaded_count",
          "ok",
          {
            error_message: JSON.stringify({
              requested: messageIds.length,
              loaded: emailBundles.length,
              missing: messageIds.length - emailBundles.length,
              mode: resolutionMode,
            }),
          },
        ),
      );
      processingLog.push(
        makeLog("", null, null, "export_validation_completed", bundle.validation.validation_status, {
          duration_ms: Date.now() - exportStart,
        }),
      );
      // If the manifest reconciliation produced any errors, emit one
      // explicit `export_validation_error` event per error so consumers
      // tailing the processing log see the specific math problem (not just
      // a "validation_failed" status without context).
      if (
        bundle.validation.validation_status === "failed" ||
        bundle.validation.validation_errors.length > 0
      ) {
        for (const verr of bundle.validation.validation_errors) {
          processingLog.push(
            makeLog("", null, null, "export_validation_error", "failed", {
              error_category: "manifest_reconciliation",
              error_message: verr,
            }),
          );
        }
      }
      // ----------------------------------------------------------------
      // PRE-WRITE JSON SAFETY GATE
      //
      // Build & validate every JSON section BEFORE any byte of the ZIP
      // (or response headers) is sent. This is the single chokepoint
      // that stops `JSON.stringify(undefined)` ever being passed to
      // archiver — which is what wrote the literal text "undefined"
      // into full_export.json and export_manifest.json in production.
      //
      // If any section fails to serialize, we emit an
      // `export_json_validation_failed` log entry and return HTTP 500
      // with the exact wording requested. The user sees a real error
      // instead of downloading a broken ZIP.
      // ----------------------------------------------------------------
      processingLog.push(
        makeLog("", null, null, "export_data_built", "ok", {
          duration_ms: Date.now() - exportStart,
          error_message: JSON.stringify({
            full_export_length: Array.isArray(bundle.fullExport)
              ? bundle.fullExport.length
              : null,
            attachments_index_length: Array.isArray(bundle.attachmentsIndex)
              ? bundle.attachmentsIndex.length
              : null,
            errors_report_length: Array.isArray(bundle.errorsReport)
              ? bundle.errorsReport.length
              : null,
          }),
        }),
      );
      processingLog.push(
        makeLog("", null, null, "export_json_validation_started", "ok", {
          duration_ms: Date.now() - exportStart,
        }),
      );

      let serialized: SerializedBundleEntries;
      try {
        // Note on shapes: full_export, attachments_index and
        // errors_report are arrays (possibly empty); manifest is an
        // object; processing_log is an array (re-serialized below to
        // include the terminal events). ai_ingestion is JSONL (one
        // JSON object per line, joined by "\n") and is therefore
        // already a string; the streamer's assertNonEmptyString gate
        // verifies it is non-empty before append. Any failure here
        // is caught and surfaces as HTTP 500 with the exact wording
        // requested ("Export failed: export data was undefined
        // before file write.").
        const fullExportJson = serializeJsonSafe(
          bundle.fullExport,
          "full_export.json",
          { expect: "array" },
        );
        const manifestJson = serializeJsonSafe(
          bundle.manifest,
          "export_manifest.json",
          { expect: "object" },
        );
        const attachmentsIndexJson = serializeJsonSafe(
          bundle.attachmentsIndex,
          "attachments_index.json",
          { expect: "array" },
        );
        const processingLogJson = serializeJsonSafe(
          processingLog,
          "processing_log.json",
          { expect: "array" },
        );
        const errorsReportJson = serializeJsonSafe(
          bundle.errorsReport,
          "errors_report.json",
          { expect: "array" },
        );
        if (typeof bundle.aiIngestion !== "string") {
          throw new SafeJsonError(
            "ai_ingestion.jsonl",
            `Expected aiIngestion to be a string, got ${
              bundle.aiIngestion === undefined
                ? "undefined"
                : typeof bundle.aiIngestion
            }.`,
          );
        }
        serialized = {
          fullExportJson,
          aiIngestion: bundle.aiIngestion,
          attachmentsIndexJson,
          manifestJson,
          processingLogJson,
          errorsReportJson,
        };
      } catch (jsonErr) {
        const which =
          jsonErr instanceof SafeJsonError ? jsonErr.safeJsonName : "unknown";
        const detail =
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
        processingLog.push(
          makeLog("", null, null, "export_json_validation_failed", "failed", {
            error_category: "manifest_reconciliation",
            error_message: JSON.stringify({ section: which, detail }),
          }),
        );
        req.log.error(
          { err: jsonErr, section: which },
          "[export] pre-write JSON validation failed; refusing to write ZIP",
        );
        // Headers have NOT been set yet (we're still pre-stream), so we
        // can return a real JSON error to the client.
        if (!res.headersSent) {
          res.status(500).json({
            error: "Export failed: export data was undefined before file write.",
            detail,
            section: which,
            processingLog,
          });
        } else {
          res.destroy(jsonErr instanceof Error ? jsonErr : new Error(detail));
        }
        return;
      }

      // Push BOTH terminal log events BEFORE we re-serialize the
      // processing_log so they make it into the ZIP entry. Anything
      // pushed after this point (e.g. `export_file_written`, which is
      // logically post-stream) goes only to console / req.log.
      processingLog.push(
        makeLog("", null, null, "export_file_validation_completed", "ok", {
          duration_ms: Date.now() - exportStart,
          error_message: JSON.stringify({
            full_export_bytes: serialized.fullExportJson.length,
            manifest_bytes: serialized.manifestJson.length,
            attachments_index_bytes: serialized.attachmentsIndexJson.length,
            processing_log_bytes: serialized.processingLogJson.length,
            errors_report_bytes: serialized.errorsReportJson.length,
            ai_ingestion_bytes: serialized.aiIngestion.length,
          }),
        }),
      );
      processingLog.push(
        makeLog("", null, null, "export_completed", "success", {
          duration_ms: Date.now() - exportStart,
          error_message: JSON.stringify({
            export_id: bundle.exportId,
            email_count: bundle.manifest.email_count,
            attachment_count: bundle.manifest.attachment_count_total,
            mode: resolutionMode,
          }),
        }),
      );

      // Final re-serialization of processing_log so the snapshot inside
      // the ZIP includes the `export_file_validation_completed` and
      // `export_completed` events that were just pushed. Routed through
      // the same `serializeJsonSafe` chokepoint so the validation
      // guarantee still holds.
      try {
        const finalProcessingLogJson = serializeJsonSafe(
          processingLog,
          "processing_log.json",
          { expect: "array" },
        );
        serialized = { ...serialized, processingLogJson: finalProcessingLogJson };
      } catch (jsonErr) {
        const detail =
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
        if (!res.headersSent) {
          res.status(500).json({
            error: "Export failed: export data was undefined before file write.",
            detail,
            section: "processing_log.json",
            processingLog,
          });
        } else {
          res.destroy(jsonErr instanceof Error ? jsonErr : new Error(detail));
        }
        return;
      }

      // Final structured console summary
      const m = bundle.manifest;
      console.log("[export.summary]", {
        export_id: bundle.exportId,
        emails_total: m.email_count,
        emails_with_body: m.email_body_success_count,
        emails_with_body_errors: m.email_body_failure_count,
        attachments_total: m.attachment_count_total,
        attachments_supported: m.attachment_supported_count,
        attachments_unsupported: m.attachment_unsupported_count,
        attachments_success: m.attachment_extracted_success_count,
        attachments_partial: m.attachment_partial_count,
        attachments_failed: m.attachment_failure_count,
        attachments_skipped: m.attachment_skipped_count,
        duplicate_attachments: m.duplicate_attachments_count,
        ocr_pages: ocrImages.length,
        emails_with_has_attachment_label: totalEmailsWithLabel,
        validation_status: bundle.validation.validation_status,
        validation_errors: bundle.validation.validation_errors.length,
        validation_warnings: bundle.validation.validation_warnings.length,
        failure_breakdown: m.failure_breakdown,
        bundle_files: 6 + dedupedBuffers.length + ocrImages.length,
        duration_ms: Date.now() - exportStart,
      });

      // Persist export log
      try {
        await db.insert(exportLogsTable).values({
          userId: session.userId!,
          exportId: bundle.exportId,
          format: "zip",
          count: emailBundles.length,
          queryUsed: queryUsed || null,
        });
      } catch (logErr) {
        req.log.warn(
          { err: logErr },
          "[export] failed to persist export log row (continuing)",
        );
      }

      // Stream the ZIP response (and tee to disk)
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const rootDir = `gmail-export-${ts}`;
      const zipFilename = `${rootDir}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${zipFilename}"`,
      );
      // Surface key counts via headers so the frontend can render summary
      // without re-parsing the manifest from inside the ZIP.
      res.setHeader("X-Export-Id", bundle.exportId);
      res.setHeader("X-Export-Email-Count", String(m.email_count));
      res.setHeader(
        "X-Export-Attachment-Count",
        String(m.attachment_count_total),
      );
      res.setHeader(
        "X-Export-Attachment-Success",
        String(m.attachment_extracted_success_count),
      );
      res.setHeader(
        "X-Export-Attachment-Failed",
        String(m.attachment_failure_count),
      );
      res.setHeader(
        "X-Export-Attachment-Unsupported",
        String(m.attachment_unsupported_count),
      );
      res.setHeader(
        "X-Export-Attachment-Duplicate",
        String(m.duplicate_attachments_count),
      );
      res.setHeader(
        "X-Export-Validation",
        bundle.validation.validation_status,
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        [
          "Content-Disposition",
          "X-Export-Id",
          "X-Export-Email-Count",
          "X-Export-Attachment-Count",
          "X-Export-Attachment-Success",
          "X-Export-Attachment-Failed",
          "X-Export-Attachment-Unsupported",
          "X-Export-Attachment-Duplicate",
          "X-Export-Validation",
        ].join(", "),
      );

      try {
        const persistResult = await streamExportZipWithDiskTee(
          serialized,
          dedupedBuffers,
          rootDir,
          res,
          ocrImages,
          {
            // Per-user root: prevents cross-user PII leakage via the
            // /api/gmail/export/latest endpoint.
            exportsRoot: userExportsRoot(session.userId!),
            exportTimestamp: ts,
            zipFilename,
          },
        );
        // After-the-fact log so the saved processing_log inside this run does
        // NOT contain the entry (it's already streamed); but we do print it
        // for ops visibility. The `export_file_written` event is the
        // post-stream confirmation that on-disk JSON+attachments landed.
        req.log.info(
          {
            export_id: bundle.exportId,
            attachment_files: dedupedBuffers.length,
            ocr_images: ocrImages.length,
            timestamped_path: persistResult.timestampedPath,
            latest_path: persistResult.latestPath,
            bytes_written: persistResult.bytesWritten,
            entry_count: persistResult.entryCount,
            event_type: "export_file_written",
          },
          "[export] zip stream + disk persist completed",
        );
      } catch (zipErr) {
        req.log.error({ err: zipErr }, "[export] zip stream failed");
        // Headers may already be flushed; force destroy.
        res.destroy(zipErr as Error);
      }
    } catch (err) {
      req.log.error({ err }, "Export error");
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to export emails" });
      } else {
        res.destroy(err as Error);
      }
    }
  },
);

// GET /api/gmail/export/latest — re-download the most recent export.
// Auth required so we don't leak somebody else's export to anonymous callers.
router.get(
  "/gmail/export/latest",
  requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>,
  async (req, res): Promise<void> => {
    const session = req.session as { userId?: number };
    if (!session.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    // Resolve to the requester's own latest.zip — never another user's.
    const latestPath = userLatestZipPath(session.userId);
    if (!existsSync(latestPath)) {
      res.status(404).json({ error: "No export has been generated yet" });
      return;
    }
    try {
      const st = await stat(latestPath);
      const tsStr = new Date(st.mtimeMs)
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const filename = `gmail-export-latest-${tsStr}.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Content-Length", String(st.size));
      res.setHeader("X-Export-Latest-Mtime", new Date(st.mtimeMs).toISOString());
      res.setHeader(
        "Access-Control-Expose-Headers",
        ["Content-Disposition", "X-Export-Latest-Mtime"].join(", "),
      );
      const stream = createReadStream(latestPath);
      stream.on("error", (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read latest export" });
        } else {
          res.destroy(err);
        }
      });
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: "Failed to serve latest export",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },
);

// HEAD /api/gmail/export/latest — lightweight existence check used by the UI
// to decide whether to enable the "Download Latest" button.
router.head(
  "/gmail/export/latest",
  requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>,
  async (req, res): Promise<void> => {
    const session = req.session as { userId?: number };
    if (!session.userId) {
      res.status(401).end();
      return;
    }
    const latestPath = userLatestZipPath(session.userId);
    if (!existsSync(latestPath)) {
      res.status(404).end();
      return;
    }
    try {
      const st = statSync(latestPath);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(st.size));
      res.setHeader("X-Export-Latest-Mtime", new Date(st.mtimeMs).toISOString());
      res.setHeader(
        "Access-Control-Expose-Headers",
        "X-Export-Latest-Mtime",
      );
      res.status(200).end();
    } catch {
      res.status(404).end();
    }
  },
);

// Recursively collect parts that should be exported as attachments.
// A part qualifies when ANY of:
//   - it has a non-empty filename
//   - it is an image/* (inline or otherwise) with downloadable bytes
//   - it is message/rfc822 (nested email)
// Parts without an attachmentId but with body.data are still included; the
// extractor uses body.data as a fallback so inline images/data parts are
// downloaded and hashed.
function isAttachmentLikeMime(m: string | null | undefined): boolean {
  if (!m) return false;
  const low = m.toLowerCase();
  return (
    low.startsWith("image/") ||
    low === "message/rfc822" ||
    low.startsWith("application/") ||
    low === "text/csv" ||
    low === "text/html"
  );
}

function collectAttachmentParts(
  parts: Array<{
    partId?: string | null;
    mimeType?: string | null;
    filename?: string | null;
    body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
    headers?: { name?: string | null; value?: string | null }[] | null;
    parts?: unknown[];
  }>,
): Array<{
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
}> {
  const result: ReturnType<typeof collectAttachmentParts> = [];
  for (const part of parts) {
    const hasFilename = !!(part.filename && part.filename.length > 0);
    const hasBytes = !!(part.body?.attachmentId || part.body?.data);
    const looksLikeAttachment = isAttachmentLikeMime(part.mimeType);
    // multipart/* containers carry no payload of their own; recurse only.
    const isMultipartContainer = !!(
      part.mimeType && part.mimeType.toLowerCase().startsWith("multipart/")
    );
    if (
      !isMultipartContainer &&
      hasBytes &&
      (hasFilename || looksLikeAttachment)
    ) {
      result.push(part);
    }
    if (part.parts && Array.isArray(part.parts)) {
      result.push(
        ...collectAttachmentParts(
          part.parts as Parameters<typeof collectAttachmentParts>[0],
        ),
      );
    }
  }
  return result;
}

export default router;
