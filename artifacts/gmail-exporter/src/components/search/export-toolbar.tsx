import { useExportEmails, getGetExportLogsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Download, Loader2, X, FileArchive, CheckCircle2, AlertTriangle, FileQuestion, Mail, Paperclip, FileJson, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface ExportToolbarProps {
  selectedCount: number;
  selectedMessageIds: string[];
  queryUsed?: string;
  searchFilters?: Record<string, unknown>;
  onClearSelection: () => void;
  onExportComplete?: (result: ExportResult) => void;
}

export interface ExportResult {
  manifest: {
    export_id: string;
    exported_at: string;
    email_count: number;
    attachment_count_total: number;
    attachment_extracted_success_count: number;
    attachment_failure_count: number;
    attachment_unsupported_count: number;
    attachment_skipped_count: number;
    email_body_failure_count: number;
    failure_breakdown: Record<string, number>;
    emails_with_any_errors: string[];
    attachments_requiring_user_action: Array<{
      message_id: string;
      attachment_id: string;
      filename: string;
      reason: string;
      suggested_user_action: string;
    }>;
  };
}

type ExportMode = "raw" | "ai" | "full";

const EXPORT_MODES: Record<ExportMode, { label: string; short: string; description: string; icon: typeof FileJson }> = {
  raw: {
    label: "Raw export",
    short: "Raw",
    description: "Single full_export.json — every field exactly as fetched, no chunking, no extras.",
    icon: FileJson,
  },
  ai: {
    label: "AI-optimized export",
    short: "AI-ready",
    description: "ai_ingestion.jsonl — one JSON object per line, content + summary fields ready for ChatGPT / RAG ingestion.",
    icon: Sparkles,
  },
  full: {
    label: "Full export with attachments",
    short: "Full bundle",
    description: "Everything: full_export.json, ai_ingestion.jsonl, export_manifest.json, attachments_index.json, processing_log.json.",
    icon: FileArchive,
  },
};

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

interface SummaryStats {
  emailsExported: number;
  emailsWithAttachments: number;
  totalAttachments: number;
  extractedSuccess: number;
  failed: number;
  unsupported: number;
  filesDownloaded: string[];
  modeUsed: ExportMode;
  exportId: string;
}

export function ExportToolbar({
  selectedCount,
  selectedMessageIds,
  queryUsed,
  searchFilters,
  onClearSelection,
  onExportComplete,
}: ExportToolbarProps) {
  const exportEmails = useExportEmails();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [lastExportId, setLastExportId] = useState<string | null>(null);
  const [mode, setMode] = useState<ExportMode>("full");
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const handleExport = () => {
    if (selectedMessageIds.length === 0) return;

    exportEmails.mutate(
      {
        data: {
          messageIds: selectedMessageIds,
          queryUsed,
          chunkLargeBodies: false,
          ...(searchFilters ? { searchFilters } : {}),
        },
      },
      {
        onSuccess: (response) => {
          queryClient.invalidateQueries({ queryKey: getGetExportLogsQueryKey() });
          setLastExportId(response.exportId);

          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const baseFilename = `gmail-export-${timestamp}`;
          const filesDownloaded: string[] = [];

          try {
            const manifest = response.manifest as ExportResult["manifest"] | null;
            const records: Array<Record<string, unknown>> = Array.isArray(response.fullExport)
              ? (response.fullExport as Array<Record<string, unknown>>)
              : [];

            // Guarantee attachments is always an array on every record (defensive client-side)
            for (const r of records) {
              if (!Array.isArray((r as { attachments?: unknown }).attachments)) {
                (r as { attachments: unknown[] }).attachments = [];
              }
              const meta = (r as { metadata?: Record<string, unknown> }).metadata;
              if (meta && typeof (meta as { has_attachments?: unknown }).has_attachments !== "boolean") {
                (meta as { has_attachments: boolean }).has_attachments =
                  ((r as { attachments: unknown[] }).attachments).length > 0;
              }
              if (meta && typeof (meta as { attachment_count?: unknown }).attachment_count !== "number") {
                (meta as { attachment_count: number }).attachment_count =
                  ((r as { attachments: unknown[] }).attachments).length;
              }
            }

            const attachmentsIndex = (response as { attachmentsIndex?: unknown[] }).attachmentsIndex;
            const processingLog = (response as { processingLog?: unknown[] }).processingLog;
            const aiIngestion = response.aiIngestion;

            // Decide which files to write based on selected mode
            if (mode === "raw" || mode === "full") {
              downloadBlob(
                JSON.stringify(response.fullExport, null, 2),
                `${baseFilename}_full_export.json`,
                "application/json",
              );
              filesDownloaded.push(`${baseFilename}_full_export.json`);
            }

            if ((mode === "ai" || mode === "full") && aiIngestion) {
              downloadBlob(
                typeof aiIngestion === "string" ? aiIngestion : JSON.stringify(aiIngestion),
                `${baseFilename}_ai_ingestion.jsonl`,
                "application/x-ndjson",
              );
              filesDownloaded.push(`${baseFilename}_ai_ingestion.jsonl`);
            }

            if (mode === "full") {
              downloadBlob(
                JSON.stringify(response.manifest, null, 2),
                `${baseFilename}_export_manifest.json`,
                "application/json",
              );
              filesDownloaded.push(`${baseFilename}_export_manifest.json`);

              if (Array.isArray(attachmentsIndex)) {
                downloadBlob(
                  JSON.stringify(attachmentsIndex, null, 2),
                  `${baseFilename}_attachments_index.json`,
                  "application/json",
                );
                filesDownloaded.push(`${baseFilename}_attachments_index.json`);
              }
              if (Array.isArray(processingLog) && processingLog.length > 0) {
                downloadBlob(
                  JSON.stringify(processingLog, null, 2),
                  `${baseFilename}_processing_log.json`,
                  "application/json",
                );
                filesDownloaded.push(`${baseFilename}_processing_log.json`);
              }
            }

            // Build user-facing summary
            const emailsExported = response.count ?? records.length;
            const emailsWithAttachments = records.filter((r) => {
              const atts = (r as { attachments?: unknown[] }).attachments;
              return Array.isArray(atts) && atts.length > 0;
            }).length;

            const stats: SummaryStats = {
              emailsExported,
              emailsWithAttachments,
              totalAttachments: manifest?.attachment_count_total ?? 0,
              extractedSuccess: manifest?.attachment_extracted_success_count ?? 0,
              failed: manifest?.attachment_failure_count ?? 0,
              unsupported: manifest?.attachment_unsupported_count ?? 0,
              filesDownloaded,
              modeUsed: mode,
              exportId: response.exportId,
            };
            setSummary(stats);
            setSummaryOpen(true);

            toast({
              description: `Exported ${emailsExported} email${emailsExported === 1 ? "" : "s"} (${EXPORT_MODES[mode].short}). ${filesDownloaded.length} file${filesDownloaded.length === 1 ? "" : "s"} downloaded.`,
            });

            if (onExportComplete && manifest) {
              onExportComplete({ manifest });
            }
          } catch (err) {
            console.error("Failed to trigger download:", err);
            toast({ variant: "destructive", description: "Export completed but download failed." });
          }
        },
        onError: (err) => {
          toast({ variant: "destructive", description: "Export failed: " + ((err as { error?: string }).error || "Unknown error") });
        },
      },
    );
  };

  const ModeIcon = EXPORT_MODES[mode].icon;

  if (selectedCount === 0) {
    return (
      <div className="h-10 flex items-center justify-between px-2 text-sm text-muted-foreground">
        <span>Select emails below to export.</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between px-2 py-1 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="px-2 py-1 text-sm font-medium">
            {selectedCount} selected
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearSelection}
            className="text-muted-foreground hover:text-foreground h-8 px-2"
            data-testid="button-clear-selection"
          >
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {lastExportId && !exportEmails.isPending && (
            <button
              type="button"
              onClick={() => summary && setSummaryOpen(true)}
              className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
              data-testid="button-show-summary"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>Bundle downloaded — view summary</span>
            </button>
          )}

          <Select value={mode} onValueChange={(v) => setMode(v as ExportMode)}>
            <SelectTrigger className="h-9 w-[230px]" data-testid="select-export-mode">
              <div className="flex items-center gap-2 truncate">
                <ModeIcon className="h-3.5 w-3.5 shrink-0" />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(EXPORT_MODES) as ExportMode[]).map((k) => {
                const m = EXPORT_MODES[k];
                const Icon = m.icon;
                return (
                  <SelectItem key={k} value={k} data-testid={`option-mode-${k}`}>
                    <div className="flex items-start gap-2 py-0.5">
                      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                      <div className="flex flex-col">
                        <span className="font-medium text-sm">{m.label}</span>
                        <span className="text-[11px] text-muted-foreground leading-tight max-w-[260px]">
                          {m.description}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          <Button
            onClick={handleExport}
            disabled={exportEmails.isPending}
            className="h-9"
            data-testid="button-execute-export"
          >
            {exportEmails.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {exportEmails.isPending ? "Exporting…" : `Export (${EXPORT_MODES[mode].short})`}
          </Button>
        </div>
      </div>

      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="max-w-lg" data-testid="dialog-export-summary">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              Export complete
            </DialogTitle>
            <DialogDescription>
              {summary && (
                <>Mode: <span className="font-medium">{EXPORT_MODES[summary.modeUsed].label}</span> · ID: <code className="text-[11px]">{summary.exportId}</code></>
              )}
            </DialogDescription>
          </DialogHeader>

          {summary && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <SummaryStat icon={<Mail className="h-4 w-4" />} label="Emails exported" value={summary.emailsExported} />
                <SummaryStat icon={<Paperclip className="h-4 w-4" />} label="Emails with attachments" value={summary.emailsWithAttachments} />
                <SummaryStat icon={<FileArchive className="h-4 w-4" />} label="Total attachments" value={summary.totalAttachments} />
                <SummaryStat icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />} label="Extracted successfully" value={summary.extractedSuccess} tone="success" />
                <SummaryStat icon={<AlertTriangle className="h-4 w-4 text-destructive" />} label="Failed" value={summary.failed} tone={summary.failed > 0 ? "error" : "muted"} />
                <SummaryStat icon={<FileQuestion className="h-4 w-4 text-amber-500" />} label="Unsupported" value={summary.unsupported} tone={summary.unsupported > 0 ? "warn" : "muted"} />
              </div>

              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1.5">Files downloaded ({summary.filesDownloaded.length})</div>
                <ul className="space-y-1 text-xs font-mono bg-muted/40 rounded p-2 max-h-32 overflow-auto">
                  {summary.filesDownloaded.map((f) => (
                    <li key={f} className="flex items-center gap-1.5">
                      <FileJson className="h-3 w-3 shrink-0 text-muted-foreground" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>

              {summary.failed === 0 && summary.unsupported === 0 ? (
                <div className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded p-2">
                  All attachments processed cleanly. Exported records include <code>metadata.has_attachments</code>, <code>metadata.attachment_count</code>, and an <code>attachments[]</code> array (empty when none).
                </div>
              ) : (
                <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2">
                  Some attachments need attention. Open the Problems panel below the table for per-file actions, or inspect <code>processing_log.json</code> for the full audit trail.
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSummaryOpen(false)} data-testid="button-close-summary">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SummaryStat({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "neutral" | "success" | "error" | "warn" | "muted";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "error"
      ? "text-destructive"
      : tone === "warn"
      ? "text-amber-700 dark:text-amber-400"
      : tone === "muted"
      ? "text-muted-foreground"
      : "text-foreground";
  return (
    <div className="border rounded-md p-2.5 bg-card">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-semibold mt-0.5 ${toneClass}`}>{value}</div>
    </div>
  );
}
