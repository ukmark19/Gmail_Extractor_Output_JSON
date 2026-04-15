import { useGetEmailMessage } from "@workspace/api-client-react";
import { X, Paperclip, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";

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
                  <div className="p-4 space-y-2">
                    {message.attachments && message.attachments.length > 0 ? (
                      message.attachments.map((att, i) => (
                        <div key={i} className="flex items-center gap-3 p-3 border rounded-md bg-card">
                          <div className="bg-muted p-2 rounded">
                            <Paperclip className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{att.filename || 'Unnamed attachment'}</p>
                            <p className="text-xs text-muted-foreground">{att.mimeType} • {att.size ? Math.round(att.size / 1024) + ' KB' : 'Unknown size'}</p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center p-8 text-muted-foreground">
                        <Paperclip className="h-8 w-8 mx-auto mb-2 opacity-20" />
                        <p>No attachments found.</p>
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
