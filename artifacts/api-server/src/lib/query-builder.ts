// Gmail Query Builder
// Converts UI search fields into valid Gmail search query syntax

interface SearchFields {
  keywords?: string;
  from?: string;
  to?: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  hasWords?: string;
  doesNotHave?: string;
  label?: string;
  dateFrom?: string;
  dateTo?: string;
  allDates?: boolean;
  hasAttachment?: boolean;
  onlyUnread?: boolean;
  onlyStarred?: boolean;
  exactPhrase?: string;
}

// Escape special characters to avoid injection into query
function escapeQueryTerm(term: string): string {
  return term.trim().replace(/[<>]/g, "");
}

// Format date as YYYY/MM/DD for Gmail query
function formatDateForGmail(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/**
 * Build a Gmail search query string from structured search fields.
 * Maps UI field values to Gmail search operators.
 */
export function buildGmailQuery(fields: SearchFields, rawQuery = ""): string {
  if (rawQuery.trim()) {
    return rawQuery.trim();
  }

  const parts: string[] = [];

  // Keywords — bare terms, searched across all fields by Gmail
  if (fields.keywords?.trim()) {
    const kw = escapeQueryTerm(fields.keywords);
    parts.push(kw);
  }

  // Exact phrase
  if (fields.exactPhrase?.trim()) {
    const phrase = escapeQueryTerm(fields.exactPhrase);
    parts.push(`"${phrase}"`);
  }

  // From — "From" and "Sender" both map to from: operator in Gmail
  // We merge them, preferring "sender" if both provided
  const fromValue = fields.sender?.trim() || fields.from?.trim();
  if (fromValue) {
    parts.push(`from:${escapeQueryTerm(fromValue)}`);
  }

  // To — "To" and "Recipient" both map to to: operator
  const toValue = fields.recipient?.trim() || fields.to?.trim();
  if (toValue) {
    parts.push(`to:${escapeQueryTerm(toValue)}`);
  }

  // Subject
  if (fields.subject?.trim()) {
    const subj = escapeQueryTerm(fields.subject);
    // Wrap in parens if multiple words
    if (subj.includes(" ")) {
      parts.push(`subject:(${subj})`);
    } else {
      parts.push(`subject:${subj}`);
    }
  }

  // Has words
  if (fields.hasWords?.trim()) {
    parts.push(escapeQueryTerm(fields.hasWords));
  }

  // Does not have
  if (fields.doesNotHave?.trim()) {
    const terms = escapeQueryTerm(fields.doesNotHave).split(/\s+/);
    for (const term of terms) {
      if (term) parts.push(`-${term}`);
    }
  }

  // Label
  if (fields.label?.trim()) {
    parts.push(`label:${escapeQueryTerm(fields.label)}`);
  }

  // Date filters — only applied if allDates is not checked
  if (!fields.allDates) {
    if (fields.dateFrom?.trim()) {
      const formatted = formatDateForGmail(fields.dateFrom);
      if (formatted) {
        parts.push(`after:${formatted}`);
      }
    }
    if (fields.dateTo?.trim()) {
      const formatted = formatDateForGmail(fields.dateTo);
      if (formatted) {
        parts.push(`before:${formatted}`);
      }
    }
  }

  // Boolean filters
  if (fields.hasAttachment) {
    parts.push("has:attachment");
  }

  if (fields.onlyUnread) {
    parts.push("is:unread");
  }

  if (fields.onlyStarred) {
    parts.push("is:starred");
  }

  return parts.join(" ").trim();
}
