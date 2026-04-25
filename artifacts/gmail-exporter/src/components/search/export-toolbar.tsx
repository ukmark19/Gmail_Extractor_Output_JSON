import { getGetExportLogsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Download,
  Loader2,
  X,
  FileArchive,
  CheckCircle2,
  AlertTriangle,
  FileQuestion,
  Mail,
  Paperclip,
  ShieldCheck,
  ShieldAlert,
  Lock,
  Copy,
  Eye,
  History,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
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
  /**
   * Total number of search hits Gmail reported for this query (the
   * approximate `resultSizeEstimate`). Used to show "Export all matching
   * (~N)" — not the cap actually exported.
   */
  totalEstimate?: number;
  /**
   * If the search-form gave us an `includeSpamTrash` choice, forward it so
   * the server-side re-fetch matches what the user is seeing.
   */
  includeSpamTrash?: boolean;
  /**
   * Hard cap to send to the server when the user clicks "Export all
   * matching results". Server still enforces a 500 ceiling.
   */
  exportAllCap?: number;
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
    duplicate_attachments_count: number;
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

interface SummaryStats {
  emailsExported: number;
  totalAttachments: number;
  extractedSuccess: number;
  failed: number;
  unsupported: number;
  duplicates: number;
  zipFilename: string;
  zipSizeBytes: number;
  exportId: string;
  validationStatus: string;
  /**
   * Categories the user should be aware of, decoded from headers + the
   * X-Export-Attachment-* counts. The Problems panel renders one row per
   * non-zero category.
   */
  problems: ProblemRow[];
}

interface ProblemRow {
  category:
    | "failed"
    | "unsupported"
    | "ocr_required"
    | "protected_pdf"
    | "duplicate";
  count: number;
  label: string;
  hint: string;
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so Safari/Firefox finish the download
  setTimeout(() => window.URL.revokeObjectURL(url), 1500);
}

function parseFilenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const m = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return m ? m[1] : null;
}

/**
 * Build the visible Problems-panel rows from the response headers we got
 * from the export endpoint. We only show rows for categories with count > 0
 * so the panel stays empty (and disappears) on a clean run.
 */
function buildProblemRows(args: {
  failed: number;
  unsupported: number;
  duplicates: number;
}): ProblemRow[] {
  const out: ProblemRow[] = [];
  if (args.failed > 0) {
    out.push({
      category: "failed",
      count: args.failed,
      label: "Extraction failures",
      hint: "Open errors_report.json in the ZIP for the per-attachment reason and suggested action.",
    });
  }
  if (args.unsupported > 0) {
    out.push({
      category: "unsupported",
      count: args.unsupported,
      label: "Unsupported file types",
      hint: "These attachments were saved as bytes but no text was extracted (e.g. binary types we can't parse).",
    });
  }
  if (args.duplicates > 0) {
    out.push({
      category: "duplicate",
      count: args.duplicates,
      label: "Duplicate attachments",
      hint: "Identical bytes were stored once in the ZIP — duplicate index entries point at the original via duplicate_of.",
    });
  }
  return out;
}

export function ExportToolbar({
  selectedCount,
  selectedMessageIds,
  queryUsed,
  searchFilters,
  totalEstimate,
  includeSpamTrash,
  exportAllCap = 500,
  onClearSelection,
  onExportComplete,
}: ExportToolbarProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [lastExportId, setLastExportId] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [latestAvailable, setLatestAvailable] = useState(false);
  const [latestMtime, setLatestMtime] = useState<string | null>(null);
  const [downloadingLatest, setDownloadingLatest] = useState(false);

  // Probe whether a `latest.zip` exists on disk so we can enable the
  // "Download Latest" button. Re-run after every successful export so the
  // button toggles on as soon as the very first export lands.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/gmail/export/latest", {
          method: "HEAD",
          credentials: "include",
        });
        if (cancelled) return;
        setLatestAvailable(r.ok);
        setLatestMtime(r.headers.get("X-Export-Latest-Mtime"));
      } catch {
        if (!cancelled) setLatestAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lastExportId]);

  const handleDownloadLatest = async () => {
    if (downloadingLatest) return;
    setDownloadingLatest(true);
    try {
      const r = await fetch("/api/gmail/export/latest", {
        method: "GET",
        credentials: "include",
      });
      if (!r.ok) {
        throw new Error(
          r.status === 404
            ? "No previous export is available yet."
            : `Download failed (${r.status})`,
        );
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition");
      const filename =
        parseFilenameFromContentDisposition(cd) ?? "gmail-export-latest.zip";
      triggerBlobDownload(blob, filename);
      toast({ description: `Downloaded ${filename}` });
    } catch (err) {
      toast({
        variant: "destructive",
        description:
          "Could not download latest export: " +
          (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setDownloadingLatest(false);
    }
  };

  const handleExport = async (mode: "selected" | "all_matching") => {
    if (isPending) return;
    if (mode === "selected" && selectedMessageIds.length === 0) {
      toast({
        variant: "destructive",
        description: "No emails selected. Pick at least one row first.",
      });
      return;
    }
    if (mode === "all_matching" && (!queryUsed || queryUsed.trim() === "")) {
      toast({
        variant: "destructive",
        description:
          "Run a search first — there's no query to export results for.",
      });
      return;
    }
    setIsPending(true);
    try {
      // Build the payload based on mode. When the user picks "Export all
      // matching results", we deliberately send messageIds=[] + the flag so
      // the server re-executes the Gmail query and exports every hit.
      const payload =
        mode === "selected"
          ? {
              messageIds: selectedMessageIds,
              queryUsed,
              chunkLargeBodies: false,
              ...(searchFilters ? { searchFilters } : {}),
            }
          : {
              messageIds: [] as string[],
              queryUsed,
              exportAllResults: true,
              maxResults: exportAllCap,
              includeSpamTrash: !!includeSpamTrash,
              chunkLargeBodies: false,
              ...(searchFilters ? { searchFilters } : {}),
            };
      const response = await fetch("/api/gmail/export", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/zip",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let errMsg = `Export failed (${response.status})`;
        try {
          const body = await response.json();
          if (body && typeof body === "object" && "error" in body) {
            errMsg = String((body as { error: unknown }).error);
          }
        } catch {
          /* response body not JSON */
        }
        throw new Error(errMsg);
      }

      const blob = await response.blob();
      const cd = response.headers.get("Content-Disposition");
      const filename =
        parseFilenameFromContentDisposition(cd) ??
        `gmail-export-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.zip`;

      triggerBlobDownload(blob, filename);

      const exportId = response.headers.get("X-Export-Id") ?? "";
      const failed = Number(response.headers.get("X-Export-Attachment-Failed") ?? 0);
      const unsupported = Number(
        response.headers.get("X-Export-Attachment-Unsupported") ?? 0,
      );
      const duplicates = Number(
        response.headers.get("X-Export-Attachment-Duplicate") ?? 0,
      );
      const stats: SummaryStats = {
        exportId,
        emailsExported: Number(response.headers.get("X-Export-Email-Count") ?? 0),
        totalAttachments: Number(
          response.headers.get("X-Export-Attachment-Count") ?? 0,
        ),
        extractedSuccess: Number(
          response.headers.get("X-Export-Attachment-Success") ?? 0,
        ),
        failed,
        unsupported,
        duplicates,
        zipFilename: filename,
        zipSizeBytes: blob.size,
        validationStatus:
          response.headers.get("X-Export-Validation") ?? "unknown",
        problems: buildProblemRows({ failed, unsupported, duplicates }),
      };
      setLastExportId(exportId);
      setSummary(stats);
      setSummaryOpen(true);
      queryClient.invalidateQueries({ queryKey: getGetExportLogsQueryKey() });

      toast({
        description: `Exported ${stats.emailsExported} email${
          stats.emailsExported === 1 ? "" : "s"
        } as ${filename}`,
      });

      if (onExportComplete) {
        // Note: the backend no longer returns the manifest in the response body
        // (the ZIP is the body), so we synthesise a minimal manifest from headers
        // for downstream consumers.
        onExportComplete({
          manifest: {
            export_id: stats.exportId,
            exported_at: new Date().toISOString(),
            email_count: stats.emailsExported,
            attachment_count_total: stats.totalAttachments,
            attachment_extracted_success_count: stats.extractedSuccess,
            attachment_failure_count: stats.failed,
            attachment_unsupported_count: stats.unsupported,
            attachment_skipped_count: 0,
            duplicate_attachments_count: stats.duplicates,
            email_body_failure_count: 0,
            failure_breakdown: {},
            emails_with_any_errors: [],
            attachments_requiring_user_action: [],
          },
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        description:
          "Export failed: " +
          (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setIsPending(false);
    }
  };

  // Whether there's a meaningful "all matching" target. We require both a
  // query AND at least one row currently shown — otherwise the button would
  // either trigger an empty re-fetch or run a query the user can't see the
  // basis for.
  const canExportAll =
    !!queryUsed && queryUsed.trim() !== "" && (totalEstimate ?? 0) > 0;
  const allMatchingLabel = canExportAll
    ? totalEstimate && totalEstimate > exportAllCap
      ? `Export all matching (~${totalEstimate}, capped at ${exportAllCap})`
      : `Export all matching${
          totalEstimate ? ` (~${totalEstimate})` : ""
        }`
    : "Export all matching";

  if (selectedCount === 0) {
    return (
      <div className="h-10 flex items-center justify-between px-2 text-sm text-muted-foreground gap-2 flex-wrap">
        <span className="truncate">
          {canExportAll
            ? "Select emails below, or export all matching results."
            : "Run a search to load emails, then select rows to export."}
        </span>
        <div className="flex items-center gap-2">
          {canExportAll && (
            <Button
              variant="default"
              size="sm"
              onClick={() => handleExport("all_matching")}
              disabled={isPending}
              className="h-8"
              data-testid="button-export-all-matching"
              title={
                totalEstimate
                  ? `Re-runs the Gmail query server-side and exports up to ${exportAllCap} matching messages (Gmail estimates ~${totalEstimate}).`
                  : "Re-runs the Gmail query server-side and exports every matching message."
              }
            >
              {isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-2 h-3.5 w-3.5" />
              )}
              {allMatchingLabel}
            </Button>
          )}
          {latestAvailable ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownloadLatest}
              disabled={downloadingLatest}
              className="h-8 px-2 text-xs"
              data-testid="button-download-latest-empty"
              title={
                latestMtime
                  ? `Last export: ${new Date(latestMtime).toLocaleString()}`
                  : "Re-download the most recent export"
              }
            >
              {downloadingLatest ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <History className="h-3.5 w-3.5 mr-1" />
              )}
              Download Latest
            </Button>
          ) : null}
        </div>
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
          {lastExportId && !isPending && (
            <button
              type="button"
              onClick={() => summary && setSummaryOpen(true)}
              className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
              data-testid="button-show-summary"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>ZIP downloaded — view summary</span>
            </button>
          )}

          {latestAvailable && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadLatest}
              disabled={downloadingLatest}
              className="h-9"
              data-testid="button-download-latest"
              title={
                latestMtime
                  ? `Last export: ${new Date(latestMtime).toLocaleString()}`
                  : "Re-download the most recent export"
              }
            >
              {downloadingLatest ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <History className="mr-2 h-4 w-4" />
              )}
              Download Latest
            </Button>
          )}

          {canExportAll && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExport("all_matching")}
              disabled={isPending}
              className="h-9"
              data-testid="button-execute-export-all"
              title={
                totalEstimate
                  ? `Re-runs the Gmail query and exports up to ${exportAllCap} matching messages (Gmail estimates ~${totalEstimate}).`
                  : "Re-runs the Gmail query and exports every matching message."
              }
            >
              {isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {allMatchingLabel}
            </Button>
          )}

          <Button
            onClick={() => handleExport("selected")}
            disabled={isPending}
            className="h-9"
            data-testid="button-execute-export"
            title={`Export the ${selectedCount} selected message${selectedCount === 1 ? "" : "s"} as a ZIP bundle.`}
          >
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {isPending
              ? "Building ZIP…"
              : `Export selected (${selectedCount})`}
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
                <>
                  File: <code className="text-[11px]">{summary.zipFilename}</code> · ID:{" "}
                  <code className="text-[11px]">{summary.exportId}</code>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {summary && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <SummaryStat
                  icon={<Mail className="h-4 w-4" />}
                  label="Emails exported"
                  value={summary.emailsExported}
                />
                <SummaryStat
                  icon={<Paperclip className="h-4 w-4" />}
                  label="Total attachments"
                  value={summary.totalAttachments}
                />
                <SummaryStat
                  icon={
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  }
                  label="Extracted successfully"
                  value={summary.extractedSuccess}
                  tone="success"
                />
                <SummaryStat
                  icon={
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  }
                  label="Failed"
                  value={summary.failed}
                  tone={summary.failed > 0 ? "error" : "muted"}
                />
                <SummaryStat
                  icon={
                    <FileQuestion className="h-4 w-4 text-amber-500" />
                  }
                  label="Unsupported"
                  value={summary.unsupported}
                  tone={summary.unsupported > 0 ? "warn" : "muted"}
                />
                <SummaryStat
                  icon={<Copy className="h-4 w-4 text-sky-500" />}
                  label="Duplicates collapsed"
                  value={summary.duplicates}
                  tone={summary.duplicates > 0 ? "info" : "muted"}
                />
                <SummaryStat
                  icon={<FileArchive className="h-4 w-4" />}
                  label="ZIP size"
                  value={Math.round(summary.zipSizeBytes / 1024)}
                  unit="KB"
                />
              </div>

              <div className="rounded border bg-muted/40 p-2 text-xs flex items-start gap-2">
                {summary.validationStatus === "ok" ? (
                  <ShieldCheck className="h-4 w-4 mt-0.5 text-emerald-500 shrink-0" />
                ) : (
                  <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-500 shrink-0" />
                )}
                <div>
                  <div className="font-medium">
                    Validation: {summary.validationStatus}
                  </div>
                  <div className="text-muted-foreground mt-0.5">
                    The ZIP contains <code>full_export.json</code>,{" "}
                    <code>ai_ingestion.jsonl</code>,{" "}
                    <code>attachments_index.json</code>,{" "}
                    <code>export_manifest.json</code>,{" "}
                    <code>processing_log.json</code>,{" "}
                    <code>errors_report.json</code> plus all downloaded
                    attachments under <code>extracted_attachments/</code>{" "}
                    and any OCR'd page PNGs under <code>ocr_images/</code>.
                  </div>
                </div>
              </div>

              {summary.problems.length === 0 ? (
                <div className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded p-2">
                  All attachments processed cleanly.
                </div>
              ) : (
                <div className="border border-amber-500/30 rounded-md bg-amber-500/5">
                  <div className="px-2.5 py-1.5 border-b border-amber-500/20 text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" />
                    Problems
                  </div>
                  <ul
                    className="divide-y divide-amber-500/15"
                    data-testid="export-problems-panel"
                  >
                    {summary.problems.map((p) => (
                      <li
                        key={p.category}
                        className="px-2.5 py-2 flex items-start gap-2 text-xs"
                        data-testid={`problem-row-${p.category}`}
                      >
                        <ProblemIcon category={p.category} />
                        <div className="flex-1">
                          <div className="font-medium">
                            {p.label}{" "}
                            <span className="text-muted-foreground font-normal">
                              ({p.count})
                            </span>
                          </div>
                          <div className="text-muted-foreground mt-0.5">
                            {p.hint}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSummaryOpen(false)}
              data-testid="button-close-summary"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProblemIcon({ category }: { category: ProblemRow["category"] }) {
  switch (category) {
    case "failed":
      return (
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-destructive shrink-0" />
      );
    case "unsupported":
      return (
        <FileQuestion className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
      );
    case "ocr_required":
      return (
        <Eye className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
      );
    case "protected_pdf":
      return (
        <Lock className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
      );
    case "duplicate":
      return <Copy className="h-3.5 w-3.5 mt-0.5 text-sky-500 shrink-0" />;
    default:
      return null;
  }
}

function SummaryStat({
  icon,
  label,
  value,
  unit,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  unit?: string;
  tone?: "neutral" | "success" | "error" | "warn" | "muted" | "info";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "error"
        ? "text-destructive"
        : tone === "warn"
          ? "text-amber-700 dark:text-amber-400"
          : tone === "info"
            ? "text-sky-700 dark:text-sky-400"
            : tone === "muted"
              ? "text-muted-foreground"
              : "text-foreground";
  return (
    <div className="border rounded-md p-2.5 bg-card">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-semibold mt-0.5 ${toneClass}`}>
        {value}
        {unit ? <span className="text-xs font-normal ml-1">{unit}</span> : null}
      </div>
    </div>
  );
}
