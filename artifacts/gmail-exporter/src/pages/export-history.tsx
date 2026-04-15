import { useGetAuthUser, useGetExportLogs } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Header } from "@/components/layout/header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { History, FileJson } from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";

export default function ExportHistory() {
  const { data: user, isLoading: isAuthLoading, error } = useGetAuthUser();
  const [, setLocation] = useLocation();
  const { data: exportLogsData, isLoading } = useGetExportLogs({ query: { enabled: !!user } });

  useEffect(() => {
    if (!isAuthLoading && (error || !user)) {
      setLocation("/");
    }
  }, [user, isAuthLoading, error, setLocation]);

  if (isAuthLoading || !user) return null;

  const logs = exportLogsData?.logs || [];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className="flex-1 p-6 max-w-5xl mx-auto w-full">
        <div className="flex items-center mb-6">
          <History className="mr-2 h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Export History</h1>
        </div>

        <div className="border rounded-md bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Export ID</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Count</TableHead>
                <TableHead>Query Used</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    Loading export history...
                  </TableCell>
                </TableRow>
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-48 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center">
                      <FileJson className="h-8 w-8 mb-4 text-muted" />
                      <p>No exports performed yet.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((log) => (
                  <TableRow key={log.id} data-testid={`row-export-log-${log.id}`}>
                    <TableCell className="font-mono text-xs">{log.exportId.substring(0, 8)}...</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {log.format}
                      </Badge>
                    </TableCell>
                    <TableCell>{log.count}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded text-muted-foreground font-mono max-w-xs block truncate" title={log.queryUsed}>
                        {log.queryUsed || "None"}
                      </code>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {log.createdAt ? format(new Date(log.createdAt), "MMM d, yyyy HH:mm") : "N/A"}
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
