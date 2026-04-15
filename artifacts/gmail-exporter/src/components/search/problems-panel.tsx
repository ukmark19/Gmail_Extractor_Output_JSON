import { AlertTriangle, XCircle, ShieldOff, FileX, SkipForward, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface AttachmentIssue {
  message_id: string;
  attachment_id: string;
  filename: string;
  reason: string;
  suggested_user_action: string;
}

interface FailureBreakdown {
  encrypted_or_password_protected: number;
  corrupt_or_malformed: number;
  unsupported_file_type: number;
  too_large: number;
  ocr_failed: number;
  parser_error: number;
  network_fetch_error: number;
  unknown_error: number;
}

interface ProblemsManifest {
  attachment_count_total: number;
  attachment_extracted_success_count: number;
  attachment_failure_count: number;
  attachment_unsupported_count: number;
  attachment_skipped_count: number;
  email_body_failure_count: number;
  failure_breakdown: FailureBreakdown;
  emails_with_any_errors: string[];
  attachments_requiring_user_action: AttachmentIssue[];
}

interface ProblemsPanelProps {
  manifest: ProblemsManifest;
  onDismiss: () => void;
}

type CategoryStyle = {
  icon: React.ReactNode;
  label: string;
  badgeVariant: "destructive" | "secondary" | "outline";
  className: string;
};

const categoryStyles: Record<string, CategoryStyle> = {
  encrypted_or_password_protected: {
    icon: <ShieldOff className="h-3.5 w-3.5" />,
    label: "Encrypted / Protected",
    badgeVariant: "destructive",
    className: "text-red-700 dark:text-red-400",
  },
  corrupt_or_malformed: {
    icon: <FileX className="h-3.5 w-3.5" />,
    label: "Corrupted / Malformed",
    badgeVariant: "destructive",
    className: "text-red-700 dark:text-red-400",
  },
  unsupported_file_type: {
    icon: <FileX className="h-3.5 w-3.5" />,
    label: "Unsupported Type",
    badgeVariant: "secondary",
    className: "text-yellow-700 dark:text-yellow-400",
  },
  too_large: {
    icon: <SkipForward className="h-3.5 w-3.5" />,
    label: "Skipped — Too Large",
    badgeVariant: "secondary",
    className: "text-yellow-700 dark:text-yellow-400",
  },
  ocr_failed: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    label: "OCR Failed",
    badgeVariant: "secondary",
    className: "text-yellow-700 dark:text-yellow-400",
  },
  parser_error: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    label: "Parser Error",
    badgeVariant: "destructive",
    className: "text-red-700 dark:text-red-400",
  },
  network_fetch_error: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    label: "Download Failed",
    badgeVariant: "destructive",
    className: "text-red-700 dark:text-red-400",
  },
  unknown_error: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    label: "Unknown Error",
    badgeVariant: "destructive",
    className: "text-red-700 dark:text-red-400",
  },
};

function SummaryRow({ label, value, variant = "normal" }: { label: string; value: number; variant?: "normal" | "error" | "warn" }) {
  if (value === 0) return null;
  return (
    <div className="flex items-center justify-between py-1">
      <span className={cn("text-xs", variant === "error" && "text-destructive font-medium", variant === "warn" && "text-yellow-700 dark:text-yellow-400")}>{label}</span>
      <Badge variant={variant === "error" ? "destructive" : "secondary"} className="text-xs px-2 py-0">
        {value}
      </Badge>
    </div>
  );
}

function CollapsibleSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  if (count === 0) return null;
  return (
    <div className="border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium bg-muted/50 hover:bg-muted transition-colors"
      >
        <span>{title} ({count})</span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {open && <div className="divide-y">{children}</div>}
    </div>
  );
}

export function ProblemsPanel({ manifest, onDismiss }: ProblemsPanelProps) {
  const totalProblems =
    manifest.attachment_failure_count +
    manifest.attachment_unsupported_count +
    manifest.attachment_skipped_count +
    manifest.email_body_failure_count;

  if (totalProblems === 0) return null;

  const breakdown = manifest.failure_breakdown || {};
  const breakdownEntries = Object.entries(breakdown).filter(([, v]) => v > 0);
  const actionItems = manifest.attachments_requiring_user_action || [];

  return (
    <div className="border-t border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-amber-200 dark:border-amber-800">
        <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm font-semibold">Problems &amp; Warnings</span>
          <Badge variant="secondary" className="bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-300 text-xs px-1.5 py-0">
            {totalProblems}
          </Badge>
        </div>
        <button
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
        >
          Dismiss
        </button>
      </div>

      <ScrollArea className="max-h-64">
        <div className="p-4 space-y-4">
          {/* Stats summary */}
          <div className="bg-background/80 rounded-md border p-3 space-y-0.5">
            <p className="text-xs font-semibold text-muted-foreground mb-2">Extraction Summary</p>
            <SummaryRow label="Email body extraction failed" value={manifest.email_body_failure_count} variant="error" />
            <SummaryRow label="Attachments failed extraction" value={manifest.attachment_failure_count} variant="error" />
            <SummaryRow label="Attachments unsupported type" value={manifest.attachment_unsupported_count} variant="warn" />
            <SummaryRow label="Attachments skipped (too large)" value={manifest.attachment_skipped_count} variant="warn" />
            <SummaryRow label="Emails with any error" value={manifest.emails_with_any_errors?.length || 0} variant="warn" />
          </div>

          {/* Failure breakdown */}
          {breakdownEntries.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground">Failure Categories</p>
              {breakdownEntries.map(([cat, count]) => {
                const style = categoryStyles[cat] || categoryStyles.unknown_error;
                return (
                  <div key={cat} className={cn("flex items-center gap-2 text-xs", style.className)}>
                    {style.icon}
                    <span>{style.label}</span>
                    <Badge variant={style.badgeVariant} className="ml-auto text-[10px] px-1.5 py-0">
                      {count}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}

          {/* Files needing user action */}
          <CollapsibleSection title="Requires Manual Action" count={actionItems.length}>
            {actionItems.map((item, i) => (
              <div key={i} className="px-3 py-2.5 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium truncate">{item.filename}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">msg: {item.message_id.slice(-8)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{item.reason}</p>
                <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                  Action: {item.suggested_user_action}
                </p>
              </div>
            ))}
          </CollapsibleSection>
        </div>
      </ScrollArea>
    </div>
  );
}
