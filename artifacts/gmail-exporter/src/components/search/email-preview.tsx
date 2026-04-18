import { useGetEmailMessage } from "@workspace/api-client-react";
import { X, Paperclip, Loader2, CheckCircle2, AlertTriangle, FileQuestion, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";

type AttachmentLike = {
  filename?: string;
  mimeType?: string;
  size?: number;
  attachmentId?: string;
  extractionStatus?: "success" | "failed" | "unsupported" | "pending" | string;
  extractionMethod?: string | null;
  extractedText?: string | null;
  failureCategory?: string | null;
  errorMessage?: string | null;
};

function formatBytes(n?: number) {
  if (!n || n <= 0) return "Unknown size";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusBanner(att: AttachmentLike) {
  const s = att.extractionStatus;
  if (s === "success") {
    return {
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      label: "Extracted successfully",
      className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    };
  }
  if (s === "failed") {
    return {
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      label: "Attachment detected, extraction failed",
      className: "bg-destructive/10 text-destructive border-destructive/20",
    };
  }
  if (s === "unsupported") {
    return {
      icon: <FileQuestion className="h-3.5 w-3.5" />,
      label: "Attachment detected, unsupported type",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    };
  }
  return {
    icon: <Paperclip className="h-3.5 w-3.5" />,
    label: "Attachment detected — extraction runs at export time",
    className: "bg-muted text-muted-foreground border-border",
  };
}

interface EmailPreviewProps {
  messageId: string;
  onClose: () => void;
  isSelected: boolean;
  onToggleSelect: (selected: boolean) => void;
}

export function EmailPreview({ messageId, onClose, isSelected, onToggleSelect }: EmailPreviewProps) {
  const { data: message, isLoading, error } = useGetEmailMessage(messageId);

  return (
    <div className="h-full flex flex-col bg-background text-sm">
      <div className="border-b p-3 flex items-center justify-between bg-muted/30">
        <div className="flex items-center gap-3">
          <Switch 
            id={`select-${messageId}`}
            checked={isSelected}
            onCheckedChange={onToggleSelect}
            data-testid="switch-select-export"
          />
          <Label htmlFor={`select-${messageId}`} className="font-medium cursor-pointer">
            Select for Export
          </Label>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} data-testid="button-close-preview">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-destructive p-4 text-center">
          Failed to load message details.
        </div>
      ) : message ? (
        <>
          <div className="border-b p-4 space-y-3 bg-card">
            <h2 className="text-lg font-bold leading-tight">{message.subject || '(no subject)'}</h2>
            
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground text-right font-medium">From:</span>
              <span className="font-medium">{message.from}</span>
              
              <span className="text-muted-foreground text-right font-medium">To:</span>
              <span>{message.to}</span>
              
              {message.cc && (
                <>
                  <span className="text-muted-foreground text-right font-medium">CC:</span>
                  <span>{message.cc}</span>
                </>
              )}
              
              <span className="text-muted-foreground text-right font-medium">Date:</span>
              <span>{message.date ? format(new Date(message.date), "PPpp") : "Unknown"}</span>
            </div>

            {message.labels && message.labels.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-2">
                {message.labels.map(label => (
                  <Badge key={label} variant="secondary" className="text-[10px] px-1.5 py-0">
                    {label}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <Tabs defaultValue="text" className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 pt-2 border-b bg-card">
              <TabsList className="grid w-full grid-cols-4 h-9">
                <TabsTrigger value="text" className="text-xs">Plain Text</TabsTrigger>
                <TabsTrigger value="clean" className="text-xs">Cleaned (AI)</TabsTrigger>
                <TabsTrigger value="headers" className="text-xs">Headers</TabsTrigger>
                <TabsTrigger value="attachments" className="text-xs flex gap-1">
                  <Paperclip className="h-3 w-3" />
                  {message.attachments?.length || 0}
                </TabsTrigger>
              </TabsList>
            </div>
            
            <div className="flex-1 overflow-hidden bg-background">
              <TabsContent value="text" className="h-full m-0">
                <ScrollArea className="h-full">
                  <div className="p-4 font-mono text-xs whitespace-pre-wrap leading-relaxed text-foreground/90">
                    {message.bodyPlainText || <span className="text-muted-foreground italic">No plain text content available.</span>}
                  </div>
                </ScrollArea>
              </TabsContent>
              
              <TabsContent value="clean" className="h-full m-0">
                <ScrollArea className="h-full">
                  <div className="p-4 prose prose-sm dark:prose-invert max-w-none">
                    {message.bodyHtmlStripped || <span className="text-muted-foreground italic text-xs">No HTML content available.</span>}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="headers" className="h-full m-0">
                <ScrollArea className="h-full">
                  <div className="p-4 space-y-2">
                    {message.headers && Object.entries(message.headers).map(([key, value]) => (
                      <div key={key} className="grid grid-cols-[120px_1fr] gap-4 py-1 border-b border-border/50 last:border-0">
                        <span className="font-semibold text-xs text-muted-foreground break-all">{key}</span>
                        <span className="text-xs font-mono break-all">{value}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="attachments" className="h-full m-0">
                <ScrollArea className="h-full">
                  <div className="p-4 space-y-3" data-testid="attachments-section">
                    {message.attachments && message.attachments.length > 0 ? (
                      <>
                        <div className="text-xs text-muted-foreground pb-1">
                          {message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"} on this email.
                          Extraction status reflects the most recent export run.
                        </div>
                        {(message.attachments as AttachmentLike[]).map((att, i) => {
                          const banner = statusBanner(att);
                          const hasText = !!(att.extractedText && att.extractedText.trim().length > 0);
                          const preview = hasText ? att.extractedText!.trim().slice(0, 600) : "";
                          const truncated = hasText && att.extractedText!.length > 600;
                          return (
                            <div
                              key={i}
                              className="border rounded-md bg-card overflow-hidden"
                              data-testid={`attachment-item-${i}`}
                            >
                              <div className="flex items-start gap-3 p-3 border-b">
                                <div className="bg-muted p-2 rounded shrink-0">
                                  <Paperclip className="h-4 w-4" />
                                </div>
                                <div className="flex-1 min-w-0 space-y-1">
                                  <p className="text-sm font-medium break-all" data-testid={`attachment-filename-${i}`}>
                                    {att.filename || "Unnamed attachment"}
                                  </p>
                                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                    <span data-testid={`attachment-mime-${i}`}>
                                      <span className="font-medium text-foreground/70">Type:</span> {att.mimeType || "unknown"}
                                    </span>
                                    <span data-testid={`attachment-size-${i}`}>
                                      <span className="font-medium text-foreground/70">Size:</span> {formatBytes(att.size)}
                                    </span>
                                    {att.extractionMethod && (
                                      <span data-testid={`attachment-method-${i}`}>
                                        <span className="font-medium text-foreground/70">Method:</span> {att.extractionMethod}
                                      </span>
                                    )}
                                    <span data-testid={`attachment-text-flag-${i}`}>
                                      <span className="font-medium text-foreground/70">Text extracted:</span>{" "}
                                      {hasText ? "Yes" : "No"}
                                    </span>
                                  </div>
                                </div>
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] flex items-center gap-1 shrink-0 ${banner.className}`}
                                  data-testid={`attachment-status-${i}`}
                                >
                                  {banner.icon}
                                  {banner.label}
                                </Badge>
                              </div>

                              {att.extractionStatus === "failed" && att.errorMessage && (
                                <div className="px-3 py-2 text-xs bg-destructive/5 text-destructive border-b">
                                  <span className="font-medium">Error:</span> {att.errorMessage}
                                  {att.failureCategory && (
                                    <span className="ml-2 opacity-75">({att.failureCategory})</span>
                                  )}
                                </div>
                              )}

                              {hasText && (
                                <div className="p-3 space-y-1">
                                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <FileText className="h-3 w-3" />
                                    Extracted text preview
                                  </div>
                                  <div
                                    className="text-xs font-mono whitespace-pre-wrap leading-relaxed bg-muted/40 rounded p-2 max-h-48 overflow-auto"
                                    data-testid={`attachment-preview-${i}`}
                                  >
                                    {preview}
                                    {truncated && (
                                      <span className="block mt-2 text-muted-foreground italic">
                                        … truncated. Full text appears in the export bundle.
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <div className="text-center p-8 text-muted-foreground" data-testid="attachments-empty">
                        <Paperclip className="h-8 w-8 mx-auto mb-2 opacity-20" />
                        <p>No attachments</p>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>
            </div>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}
