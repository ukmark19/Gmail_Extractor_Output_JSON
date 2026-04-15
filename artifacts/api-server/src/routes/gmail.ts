import { Router, type IRouter } from "express";
import { google } from "googleapis";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  SearchEmailsBody,
  GetEmailMessageParams,
} from "@workspace/api-zod";
import { createOAuth2Client, extractEmailParts, extractAttachments, stripHtml } from "../lib/gmail";
import { buildGmailQuery } from "../lib/query-builder";

const router: IRouter = Router();

// Auth middleware for Gmail routes
async function requireAuth(req: { session: unknown; log: { warn: (msg: string) => void; error: (arg: unknown, msg: string) => void } }, res: { status: (n: number) => { json: (d: unknown) => void } }, next: () => void): Promise<void> {
  const session = req.session as { userId?: number };
  if (!session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

function getHeaderValue(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// POST /api/gmail/search
router.post("/gmail/search", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

  const parsed = SearchEmailsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { query, fields, maxResults = 50, pageToken, includeSpamTrash = false } = parsed.data;

  // Build final Gmail query from fields or use raw query
  const finalQuery = fields ? buildGmailQuery(fields, query) : query;

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

    // Search for messages
    const searchResponse = await gmail.users.messages.list({
      userId: "me",
      q: finalQuery || "",
      maxResults: Math.min(maxResults, 500),
      pageToken: pageToken || undefined,
      includeSpamTrash,
    });

    const messageIds = searchResponse.data.messages || [];
    const nextPageToken = searchResponse.data.nextPageToken || undefined;
    const totalEstimate = searchResponse.data.resultSizeEstimate || 0;

    // Fetch message details in batches
    const messages = await Promise.all(
      messageIds.slice(0, Math.min(messageIds.length, 100)).map(async (msg) => {
        try {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });

          const headers = detail.data.payload?.headers || [];
          const labelIds = detail.data.labelIds || [];

          return {
            id: detail.data.id || "",
            threadId: detail.data.threadId || "",
            subject: getHeaderValue(headers, "Subject"),
            from: getHeaderValue(headers, "From"),
            to: getHeaderValue(headers, "To"),
            date: getHeaderValue(headers, "Date"),
            snippet: detail.data.snippet || "",
            labels: labelIds,
            hasAttachment: labelIds.includes("HAS_ATTACHMENT"),
            sizeEstimate: detail.data.sizeEstimate || 0,
            isUnread: labelIds.includes("UNREAD"),
            isStarred: labelIds.includes("STARRED"),
          };
        } catch {
          return null;
        }
      })
    );

    const validMessages = messages.filter(Boolean);

    res.json({
      messages: validMessages,
      totalEstimate,
      nextPageToken,
      queryUsed: finalQuery,
    });
  } catch (err: unknown) {
    const gmailErr = err as { code?: number; errors?: { reason?: string }[] };
    req.log.error({ err }, "Gmail search error");

    if (gmailErr?.code === 401 || gmailErr?.errors?.[0]?.reason === "authError") {
      res.status(401).json({ error: "Gmail authentication expired. Please sign in again." });
      return;
    }

    if (gmailErr?.code === 429) {
      res.status(429).json({ error: "Gmail API rate limit reached. Please wait a moment and try again." });
      return;
    }

    res.status(500).json({ error: "Failed to search Gmail" });
  }
});

// GET /api/gmail/messages/:messageId
router.get("/gmail/messages/:messageId", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

  const paramsParsed = GetEmailMessageParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid message ID" });
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

    const detail = await gmail.users.messages.get({
      userId: "me",
      id: paramsParsed.data.messageId,
      format: "full",
    });

    const headers = detail.data.payload?.headers || [];
    const labelIds = detail.data.labelIds || [];
    const parts = detail.data.payload?.parts || [];
    const body = detail.data.payload?.body;

    let bodyPlainText = "";
    let bodyHtml = "";

    if (parts.length > 0) {
      const extracted = extractEmailParts(parts);
      bodyPlainText = extracted.plain;
      bodyHtml = extracted.html;
    } else if (body?.data) {
      const mimeType = detail.data.payload?.mimeType || "";
      if (mimeType === "text/plain") {
        const { decodeBase64 } = await import("../lib/gmail");
        bodyPlainText = decodeBase64(body.data);
      } else if (mimeType === "text/html") {
        const { decodeBase64 } = await import("../lib/gmail");
        bodyHtml = decodeBase64(body.data);
      }
    }

    const bodyHtmlStripped = bodyHtml ? stripHtml(bodyHtml) : "";
    const attachments = extractAttachments(parts);

    // Build headers map
    const headersMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.name) headersMap[h.name] = h.value || "";
    }

    res.json({
      id: detail.data.id || "",
      threadId: detail.data.threadId || "",
      subject: getHeaderValue(headers, "Subject"),
      from: getHeaderValue(headers, "From"),
      to: getHeaderValue(headers, "To"),
      cc: getHeaderValue(headers, "Cc"),
      bcc: getHeaderValue(headers, "Bcc"),
      date: getHeaderValue(headers, "Date"),
      internalDate: detail.data.internalDate || "",
      snippet: detail.data.snippet || "",
      labels: labelIds,
      bodyPlainText,
      bodyHtmlStripped,
      headers: headersMap,
      attachments,
      sizeEstimate: detail.data.sizeEstimate || 0,
      isUnread: labelIds.includes("UNREAD"),
      isStarred: labelIds.includes("STARRED"),
    });
  } catch (err: unknown) {
    const gmailErr = err as { code?: number };
    req.log.error({ err }, "Gmail get message error");

    if (gmailErr?.code === 404) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    res.status(500).json({ error: "Failed to fetch message" });
  }
});

// GET /api/gmail/labels
router.get("/gmail/labels", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

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
    const labelsResponse = await gmail.users.labels.list({ userId: "me" });

    const labels = (labelsResponse.data.labels || []).map((l) => ({
      id: l.id || "",
      name: l.name || "",
      type: l.type || "",
    }));

    res.json({ labels });
  } catch (err) {
    req.log.error({ err }, "Gmail get labels error");
    res.status(500).json({ error: "Failed to fetch labels" });
  }
});

export default router;
