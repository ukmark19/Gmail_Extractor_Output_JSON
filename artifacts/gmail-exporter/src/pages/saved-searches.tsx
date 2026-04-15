import { useGetAuthUser, useGetSavedSearches, useDeleteSavedSearch, getGetSavedSearchesQueryKey } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, Search, Database } from "lucide-react";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function SavedSearches() {
  const { data: user, isLoading: isAuthLoading, error } = useGetAuthUser();
  const [, setLocation] = useLocation();
  const { data: savedSearchesData, isLoading } = useGetSavedSearches({ query: { enabled: !!user } });
  const deleteSearch = useDeleteSavedSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!isAuthLoading && (error || !user)) {
      setLocation("/");
    }
  }, [user, isAuthLoading, error, setLocation]);

  if (isAuthLoading || !user) return null;

  const searches = savedSearchesData?.savedSearches || [];

  const handleDelete = (id: number) => {
    deleteSearch.mutate({ id }, {
      onSuccess: () => {
        toast({ description: "Saved search deleted successfully" });
        queryClient.invalidateQueries({ queryKey: getGetSavedSearchesQueryKey() });
      },
      onError: () => {
        toast({ variant: "destructive", description: "Failed to delete saved search" });
      }
    });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Saved Searches</h1>
          <Button onClick={() => setLocation("/search")} variant="outline" data-testid="button-new-search">
            <Search className="mr-2 h-4 w-4" />
            New Search
          </Button>
        </div>

        <div className="border rounded-md bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Query</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    Loading saved searches...
                  </TableCell>
                </TableRow>
              ) : searches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-48 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center">
                      <Database className="h-8 w-8 mb-4 text-muted" />
                      <p>No saved searches yet.</p>
                      <Button variant="link" onClick={() => setLocation("/search")} className="mt-2">
                        Go to Search to create one
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                searches.map((search) => (
                  <TableRow key={search.id} data-testid={`row-saved-search-${search.id}`}>
                    <TableCell className="font-medium">{search.name}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded text-muted-foreground font-mono">
                        {search.query}
                      </code>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {search.createdAt ? format(new Date(search.createdAt), "MMM d, yyyy") : "N/A"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => handleDelete(search.id)}
                        disabled={deleteSearch.isPending}
                        data-testid={`button-delete-search-${search.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </main>
    </div>
  );
}
