import { EmailSummary } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Paperclip, Mail, Inbox, Star } from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ResultsTableProps {
  messages: EmailSummary[];
  isLoading: boolean;
  isLoadingMore: boolean;
  selectedIds: Set<string>;
  onSelectionChange: (id: string, selected: boolean) => void;
  onSelectAllOnPage: (selected: boolean) => void;
  onRowClick: (id: string) => void;
  onLoadMore: () => void;
  hasNextPage: boolean;
  totalEstimate: number;
  activePreviewId: string | null;
}

export function ResultsTable({
  messages,
  isLoading,
  isLoadingMore,
  selectedIds,
  onSelectionChange,
  onSelectAllOnPage,
  onRowClick,
  onLoadMore,
  hasNextPage,
  totalEstimate,
  activePreviewId
}: ResultsTableProps) {
  
  const allPageSelected = messages.length > 0 && messages.every(m => selectedIds.has(m.id));
  const somePageSelected = messages.some(m => selectedIds.has(m.id));

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center space-x-4">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-[200px]" />
            <Skeleton className="h-4 w-[300px]" />
            <Skeleton className="h-4 w-[100px]" />
          </div>
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
        <Mail className="h-12 w-12 mb-4 opacity-20" />
        <h3 className="text-lg font-medium text-foreground mb-1">No emails found</h3>
        <p className="text-sm max-w-sm">
          Run a search to find emails to extract. Use the advanced filters on the left to narrow down your results.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
            <TableRow>
              <TableHead className="w-[36px] pl-3">
                <Checkbox 
                  checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false}
                  onCheckedChange={(c) => onSelectAllOnPage(!!c)}
                  data-testid="checkbox-select-all"
                />
              </TableHead>
              <TableHead className="w-[160px]">From</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="hidden lg:table-cell">Labels</TableHead>
              <TableHead className="w-[120px]">Attachments</TableHead>
              <TableHead className="w-[80px] text-right pr-3">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {messages.map((message) => (
              <TableRow 
                key={message.id} 
                className={`cursor-pointer transition-colors ${activePreviewId === message.id ? 'bg-muted' : ''}`}
                onClick={() => onRowClick(message.id)}
                data-testid={`row-email-${message.id}`}
              >
                <TableCell className="pl-3" onClick={e => e.stopPropagation()}>
                  <Checkbox 
                    checked={selectedIds.has(message.id)}
                    onCheckedChange={(c) => onSelectionChange(message.id, !!c)}
                    data-testid={`checkbox-select-${message.id}`}
                  />
                </TableCell>
                <TableCell className={`font-medium truncate max-w-[160px] ${message.isUnread ? 'text-foreground' : 'text-muted-foreground'}`}>
                  <div className="flex items-center gap-1">
                    {message.isStarred && <Star className="h-3 w-3 fill-yellow-400 text-yellow-400 shrink-0" />}
                    <span className="truncate" title={message.from}>{message.from?.split('<')[0]?.trim() || message.from}</span>
                  </div>
                </TableCell>
                <TableCell className="truncate max-w-0">
                  <span className={message.isUnread ? 'font-bold text-foreground' : 'text-foreground'}>
                    {message.subject || '(no subject)'}
                  </span>
                  <span className="text-muted-foreground text-sm ml-2">- {message.snippet}</span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {message.labels?.filter(l => !['UNREAD', 'STARRED'].includes(l)).slice(0, 3).map(label => (
                      <Badge key={label} variant="outline" className="text-[10px] px-1 py-0 h-4">
                        {label}
                      </Badge>
                    ))}
                    {(message.labels?.length || 0) > 3 && (
                      <span className="text-[10px] text-muted-foreground">+{message.labels!.length - 3}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm" data-testid={`cell-attachments-${message.id}`}>
                  {message.hasAttachment ? (
                    <span className="inline-flex items-center gap-1 text-foreground">
                      <Paperclip className="h-3 w-3 text-muted-foreground" />
                      Yes
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </TableCell>
                <TableCell className="text-right text-muted-foreground text-sm whitespace-nowrap">
                  {message.date ? format(new Date(message.date), "MMM d") : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="border-t p-2 flex items-center justify-between bg-card text-sm text-muted-foreground">
        <div>
          Showing {messages.length} {totalEstimate > messages.length ? `of ~${totalEstimate}` : ""} results
        </div>
        <div>
          {hasNextPage && (
            <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isLoadingMore} data-testid="button-load-more">
              {isLoadingMore ? "Loading..." : "Load More"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
