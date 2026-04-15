import { SearchFields } from "@workspace/api-client-react";
import { format } from "date-fns";

export function buildGmailQuery(fields: Partial<SearchFields>): string {
  const parts: string[] = [];

  if (fields.keywords) {
    parts.push(fields.keywords);
  }
  if (fields.from) {
    parts.push(`from:${fields.from}`);
  }
  if (fields.to) {
    parts.push(`to:${fields.to}`);
  }
  if (fields.sender) {
    parts.push(`from:${fields.sender}`);
  }
  if (fields.recipient) {
    parts.push(`to:${fields.recipient}`);
  }
  if (fields.subject) {
    parts.push(`subject:(${fields.subject})`);
  }
  if (fields.hasWords) {
    parts.push(`(${fields.hasWords})`);
  }
  if (fields.doesNotHave) {
    parts.push(`-${fields.doesNotHave}`);
  }
  if (fields.label) {
    parts.push(`label:${fields.label}`);
  }
  if (fields.exactPhrase) {
    parts.push(`"${fields.exactPhrase}"`);
  }
  if (fields.hasAttachment) {
    parts.push(`has:attachment`);
  }
  if (fields.onlyUnread) {
    parts.push(`is:unread`);
  }
  if (fields.onlyStarred) {
    parts.push(`is:starred`);
  }
  
  if (!fields.allDates) {
    if (fields.dateFrom) {
      parts.push(`after:${format(new Date(fields.dateFrom), "yyyy/MM/dd")}`);
    }
    if (fields.dateTo) {
      parts.push(`before:${format(new Date(fields.dateTo), "yyyy/MM/dd")}`);
    }
  }

  // Note: includeSpamTrash is usually a separate API parameter, not a query string part, 
  // but if it needs to be in query it might be "in:anywhere"
  if (fields.includeSpamTrash) {
    parts.push(`in:anywhere`);
  }

  return parts.join(" ").trim();
}
