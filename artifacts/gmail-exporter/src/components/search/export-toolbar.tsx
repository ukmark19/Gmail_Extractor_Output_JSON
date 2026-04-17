import { useExportEmails, getGetExportLogsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Download, Loader2, X, FileArchive, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

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

          try {
            // 1. Download full_export.json
            downloadBlob(
              JSON.stringify(response.fullExport, null, 2),
              `${baseFilename}_full_export.json`,
              "application/json"
            );

            // 2. Download ai_ingestion.jsonl
            if (response.aiIngestion) {
              downloadBlob(
                typeof response.aiIngestion === "string"
                  ? response.aiIngestion
                  : JSON.stringify(response.aiIngestion),
                `${baseFilename}_ai_ingestion.jsonl`,
                "application/x-ndjson"
              );
            }

            // 3. Download export_manifest.json
            downloadBlob(
              JSON.stringify(response.manifest, null, 2),
              `${baseFilename}_export_manifest.json`,
              "application/json"
            );

            // 4. Download attachments_index.json (flat index linking attachments to parent emails)
            const attachmentsIndex = (response as { attachmentsIndex?: unknown[] }).attachmentsIndex;
            if (Array.isArray(attachmentsIndex)) {
              downloadBlob(
                JSON.stringify(attachmentsIndex, null, 2),
                `${baseFilename}_attachments_index.json`,
                "application/json"
              );
            }

            const count = response.count ?? 0;
            const manifest = response.manifest as ExportResult["manifest"] | null;
            const failCount = (manifest?.attachment_failure_count ?? 0) + (manifest?.email_body_failure_count ?? 0);
            const fileCount = Array.isArray(attachmentsIndex) ? 4 : 3;

            toast({
              description: failCount > 0
                ? `Exported ${count} emails. ${failCount} extraction issue(s) — see Problems panel.`
                : `Exported ${count} emails successfully. ${fileCount} files downloaded.`,
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
      }
    );
  };

  if (selectedCount === 0) {
    return (
      <div className="h-10 flex items-center justify-between px-2 text-sm text-muted-foreground">
        <span>Select emails below to export.</span>
      </div>
    );
  }

  return (
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

      <div className="flex items-center gap-3">
        {lastExportId && !exportEmails.isPending && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Bundle downloaded</span>
          </div>
        )}

        <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-md border border-border/50">
          <FileArchive className="h-3.5 w-3.5" />
          <span>full_export.json · ai_ingestion.jsonl · export_manifest.json</span>
        </div>

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
          {exportEmails.isPending ? "Exporting…" : "Export Bundle"}
        </Button>
      </div>
    </div>
  );
}
