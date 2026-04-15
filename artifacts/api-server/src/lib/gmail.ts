import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { logger } from "./logger";

export function createOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(oauth2Client: OAuth2Client): string {
  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });
}

export interface EmailPart {
  mimeType: string;
  body?: { data?: string; size?: number };
  parts?: EmailPart[];
  headers?: { name: string; value: string }[];
  filename?: string;
}

// Decode base64url-encoded string to UTF-8
export function decodeBase64(data: string): string {
  try {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(base64, "base64");
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

// Strip HTML tags and normalize whitespace for AI-ready output
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<h[1-6][^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Recursively extract text and HTML from email parts
export function extractEmailParts(
  parts: EmailPart[],
  plain = "",
  html = ""
): { plain: string; html: string } {
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      plain += decodeBase64(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html += decodeBase64(part.body.data);
    } else if (part.parts) {
      const result = extractEmailParts(part.parts, plain, html);
      plain = result.plain;
      html = result.html;
    }
  }
  return { plain, html };
}

// Extract attachment metadata (no actual downloading)
export function extractAttachments(
  parts: EmailPart[]
): { filename: string; mimeType: string; size: number; attachmentId: string }[] {
  const attachments: { filename: string; mimeType: string; size: number; attachmentId: string }[] = [];

  function processPartRecursive(partList: EmailPart[]): void {
    for (const part of partList) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body?.size || 0,
          attachmentId: "",
        });
      }
      if (part.parts) {
        processPartRecursive(part.parts);
      }
    }
  }

  processPartRecursive(parts);
  return attachments;
}

// Format bytes for display
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
}

// Refresh access token if expired
export async function getValidAccessToken(
  oauth2Client: OAuth2Client,
  user: { accessToken: string | null; refreshToken: string | null; tokenExpiry: Date | null }
): Promise<string> {
  if (!user.accessToken) {
    throw new Error("No access token available. Please re-authenticate.");
  }

  const now = new Date();
  const expiryBuffer = 5 * 60 * 1000; // 5 min buffer

  if (user.tokenExpiry && user.tokenExpiry.getTime() - now.getTime() > expiryBuffer) {
    return user.accessToken;
  }

  if (!user.refreshToken) {
    throw new Error("Token expired and no refresh token available. Please re-authenticate.");
  }

  oauth2Client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    const tokens = credentials as TokenSet;
    return tokens.access_token;
  } catch (err) {
    logger.error({ err }, "Failed to refresh access token");
    throw new Error("Failed to refresh access token. Please re-authenticate.");
  }
}
