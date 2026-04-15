import { useState } from "react";
import { useGetAuthUser, useSearchEmails, SearchFields, EmailSummary } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Header } from "@/components/layout/header";
import { SearchForm, SearchFormValues } from "@/components/search/search-form";
import { ResultsTable } from "@/components/search/results-table";
import { EmailPreview } from "@/components/search/email-preview";
import { ExportToolbar } from "@/components/search/export-toolbar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useToast } from "@/hooks/use-toast";

export default function SearchPage() {
  const { data: user, isLoading: isAuthLoading, error } = useGetAuthUser();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const searchEmailsMutation = useSearchEmails();

  const [searchParams, setSearchParams] = useState<{ query: string; values: SearchFormValues } | null>(null);
  const [messages, setMessages] = useState<EmailSummary[]>([]);
  const [totalEstimate, setTotalEstimate] = useState<number>(0);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [previewMessageId, setPreviewMessageId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthLoading && (error || !user)) {
      setLocation("/");
    }
  }, [user, isAuthLoading, error, setLocation]);

  const handleSearch = (query: string, values: SearchFormValues) => {
    setSearchParams({ query, values });
    setMessages([]);
    setNextPageToken(undefined);
    setSelectedMessageIds(new Set());
    setPreviewMessageId(null);
    executeSearch(query, values, undefined);
  };

  const executeSearch = (query: string, values: SearchFormValues, pageToken?: string) => {
    searchEmailsMutation.mutate({
      data: {
        query,
        maxResults: values.maxResults,
        pageToken,
        includeSpamTrash: values.includeSpamTrash,
        fields: values as SearchFields
      }
    }, {
      onSuccess: (data) => {
        if (pageToken) {
          setMessages(prev => [...prev, ...data.messages]);
        } else {
          setMessages(data.messages);
        }
        setTotalEstimate(data.totalEstimate || 0);
        setNextPageToken(data.nextPageToken);
      },
      onError: (err) => {
        toast({ variant: "destructive", description: "Search failed: " + (err.error || "Unknown error") });
      }
    });
  };

  const loadMore = () => {
    if (searchParams && nextPageToken) {
      executeSearch(searchParams.query, searchParams.values, nextPageToken);
    }
  };

  const handleSelectionChange = (id: string, selected: boolean) => {
    const newSelected = new Set(selectedMessageIds);
    if (selected) {
      newSelected.add(id);
    } else {
      newSelected.delete(id);
    }
    setSelectedMessageIds(newSelected);
  };

  const handleSelectAllOnPage = (selected: boolean) => {
    const newSelected = new Set(selectedMessageIds);
    messages.forEach(m => {
      if (selected) newSelected.add(m.id);
      else newSelected.delete(m.id);
    });
    setSelectedMessageIds(newSelected);
  };

  if (isAuthLoading || !user) return null;

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <Header />
      <main className="flex-1 overflow-hidden flex">
        <ResizablePanelGroup direction="horizontal" className="h-full items-stretch">
          <ResizablePanel defaultSize={25} minSize={20} maxSize={40} className="border-r bg-card">
            <div className="h-full overflow-y-auto p-4">
              <SearchForm onSearch={handleSearch} isLoading={searchEmailsMutation.isPending} />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={previewMessageId ? 45 : 75} className="flex flex-col bg-background relative">
            <div className="border-b p-2">
              <ExportToolbar 
                selectedCount={selectedMessageIds.size} 
                selectedMessageIds={Array.from(selectedMessageIds)}
                queryUsed={searchParams?.query}
                onClearSelection={() => setSelectedMessageIds(new Set())}
              />
            </div>
            <div className="flex-1 overflow-hidden">
              <ResultsTable 
                messages={messages} 
                isLoading={searchEmailsMutation.isPending && !nextPageToken} 
                isLoadingMore={searchEmailsMutation.isPending && !!nextPageToken}
                selectedIds={selectedMessageIds}
                onSelectionChange={handleSelectionChange}
                onSelectAllOnPage={handleSelectAllOnPage}
                onRowClick={(id) => setPreviewMessageId(id)}
                onLoadMore={loadMore}
                hasNextPage={!!nextPageToken}
                totalEstimate={totalEstimate}
                activePreviewId={previewMessageId}
              />
            </div>
          </ResizablePanel>
          {previewMessageId && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={30} minSize={25} maxSize={50} className="border-l bg-card">
                <EmailPreview 
                  messageId={previewMessageId} 
                  onClose={() => setPreviewMessageId(null)} 
                  isSelected={selectedMessageIds.has(previewMessageId)}
                  onToggleSelect={(selected) => handleSelectionChange(previewMessageId, selected)}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </main>
    </div>
  );
}
