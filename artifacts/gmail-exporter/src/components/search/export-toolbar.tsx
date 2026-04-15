import { useExportEmails, ExportEmailsBodyFormat, getGetExportLogsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Loader2, X, FileJson } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

interface ExportToolbarProps {
  selectedCount: number;
  selectedMessageIds: string[];
  queryUsed?: string;
  onClearSelection: () => void;
}

export function ExportToolbar({ selectedCount, selectedMessageIds, queryUsed, onClearSelection }: ExportToolbarProps) {
  const exportEmails = useExportEmails();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [format, setFormat] = useState<ExportEmailsBodyFormat>(ExportEmailsBodyFormat["ai-optimized"]);
  const [includeManifest, setIncludeManifest] = useState(true);
  const [chunkLargeBodies, setChunkLargeBodies] = useState(true);
  const [splitFiles, setSplitFiles] = useState(false);

  const handleExport = () => {
    if (selectedMessageIds.length === 0) return;

    exportEmails.mutate({
      data: {
        messageIds: selectedMessageIds,
        format,
        queryUsed,
        includeManifest,
        chunkLargeBodies,
        splitFiles
      }
    }, {
      onSuccess: (response) => {
        toast({ description: `Successfully exported ${response.count} emails.` });
        queryClient.invalidateQueries({ queryKey: getGetExportLogsQueryKey() });

        try {
          let content: string;
          let filenameExt: string;
          let mimeType: string;

          if (format === 'jsonl') {
            // Assume data is already a string of JSONL or array of strings
            content = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            filenameExt = "jsonl";
            mimeType = "application/x-ndjson";
          } else {
            // Format is json
            content = JSON.stringify(response, null, 2);
            filenameExt = "json";
            mimeType = "application/json";
          }

          const blob = new Blob([content], { type: mimeType });
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `gmail-export-${format}-${Date.now()}.${filenameExt}`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        } catch (err) {
          console.error("Failed to trigger download:", err);
          toast({ variant: "destructive", description: "Failed to download file." });
        }
      },
      onError: (err) => {
        toast({ variant: "destructive", description: "Export failed: " + (err.error || "Unknown error") });
      }
    });
  };

  if (selectedCount === 0) {
    return (
      <div className="h-10 flex items-center justify-between px-2 text-sm text-muted-foreground">
        <span>Select emails below to export.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row gap-4 items-center justify-between px-2 py-1">
      <div className="flex items-center gap-3">
        <Badge variant="secondary" className="px-2 py-1 text-sm font-medium">
          {selectedCount} selected
        </Badge>
        <Button variant="ghost" size="sm" onClick={onClearSelection} className="text-muted-foreground hover:text-foreground h-8 px-2" data-testid="button-clear-selection">
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden lg:flex items-center gap-4 text-xs bg-muted/50 p-1.5 rounded-md border border-border/50">
          <div className="flex items-center gap-1.5 px-2">
            <Checkbox id="opt-manifest" checked={includeManifest} onCheckedChange={(c) => setIncludeManifest(!!c)} />
            <Label htmlFor="opt-manifest" className="font-normal cursor-pointer">Manifest</Label>
          </div>
          <div className="flex items-center gap-1.5 px-2 border-l">
            <Checkbox id="opt-chunk" checked={chunkLargeBodies} onCheckedChange={(c) => setChunkLargeBodies(!!c)} />
            <Label htmlFor="opt-chunk" className="font-normal cursor-pointer">Chunk Large</Label>
          </div>
          <div className="flex items-center gap-1.5 px-2 border-l">
            <Checkbox id="opt-split" checked={splitFiles} onCheckedChange={(c) => setSplitFiles(!!c)} />
            <Label htmlFor="opt-split" className="font-normal cursor-pointer">Split Files</Label>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select value={format} onValueChange={(v: any) => setFormat(v)}>
            <SelectTrigger className="w-[160px] h-9" data-testid="select-export-format">
              <div className="flex items-center gap-2">
                <FileJson className="h-4 w-4 text-muted-foreground" />
                <SelectValue placeholder="Format" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ai-optimized">AI-Optimized JSON</SelectItem>
              <SelectItem value="raw">Raw JSON</SelectItem>
              <SelectItem value="jsonl">JSONL</SelectItem>
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
            Export
          </Button>
        </div>
      </div>
    </div>
  );
}

// Needed to add a simple Badge component mock if it didn't exist, but it should from shadcn
import { Badge } from "@/components/ui/badge";
