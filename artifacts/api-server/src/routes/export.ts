import { Router, type IRouter } from "express";
import { google } from "googleapis";
import { db, usersTable, exportLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ExportEmailsBody } from "@workspace/api-zod";
import { createOAuth2Client, extractEmailParts, extractAttachments, stripHtml, decodeBase64 } from "../lib/gmail";
import { exportEmails, type EmailData } from "../lib/export-formatter";

const router: IRouter = Router();

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

// POST /api/gmail/export
router.post("/gmail/export", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

  const parsed = ExportEmailsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { messageIds, format, queryUsed, includeManifest = true, chunkLargeBodies = false } = parsed.data;

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

    // Fetch full message details for all selected messages
    const emailDataList: EmailData[] = [];

    for (const messageId of messageIds) {
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

        if (parts.length > 0) {
          const extracted = extractEmailParts(parts);
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

        const bodyHtmlStripped = bodyHtml ? stripHtml(bodyHtml) : "";
        const attachments = extractAttachments(parts);

        const headersMap: Record<string, string> = {};
        for (const h of headers) {
          if (h.name) headersMap[h.name] = h.value || "";
        }

        // Optionally chunk large bodies
        let finalBodyPlainText = bodyPlainText;
        if (chunkLargeBodies && bodyPlainText.length > 8000) {
          finalBodyPlainText = bodyPlainText.substring(0, 8000) + "\n[...truncated for chunking]";
        }

        emailDataList.push({
          id: detail.data.id || messageId,
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
          bodyPlainText: finalBodyPlainText,
          bodyHtmlStripped,
          headers: headersMap,
          attachments,
          sizeEstimate: detail.data.sizeEstimate || 0,
        });
      } catch (err) {
        req.log.warn({ err, messageId }, "Failed to fetch message for export, skipping");
      }
    }

    const result = exportEmails(emailDataList, {
      format,
      queryUsed: queryUsed || undefined,
      includeManifest,
      chunkLargeBodies,
    });

    // Log the export
    await db.insert(exportLogsTable).values({
      userId: session.userId!,
      exportId: result.exportId,
      format,
      count: emailDataList.length,
      queryUsed: queryUsed || null,
    });

    res.json({
      data: result.data,
      manifest: result.manifest,
      format,
      count: emailDataList.length,
      exportId: result.exportId,
    });
  } catch (err) {
    req.log.error({ err }, "Export error");
    res.status(500).json({ error: "Failed to export emails" });
  }
});

export default router;
