import { useGetAuthUser } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { MailSearch, Lock, Database, FileJson, ArrowRight } from "lucide-react";
import { useEffect } from "react";

export default function Landing() {
  const { data: user, isLoading } = useGetAuthUser();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user) {
      setLocation("/search");
    }
  }, [user, setLocation]);

  if (isLoading) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-muted-foreground text-sm">Loading...</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="max-w-3xl w-full space-y-12">
        <div className="text-center space-y-6">
          <div className="inline-flex items-center justify-center p-4 bg-primary/10 rounded-full mb-4">
            <MailSearch className="h-12 w-12 text-primary" />
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground">
            Gmail Query Exporter
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            A precise, professional data extraction tool for power users. Mine your Gmail for AI knowledge base preparation with advanced querying and structured JSON exports.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <div className="p-6 bg-card rounded-xl border shadow-sm">
            <Database className="h-8 w-8 text-primary mb-4" />
            <h3 className="text-lg font-semibold mb-2">Advanced Queries</h3>
            <p className="text-muted-foreground text-sm">
              Build complex Gmail search queries with our visual builder. Save your best queries for repeatable extraction.
            </p>
          </div>
          <div className="p-6 bg-card rounded-xl border shadow-sm">
            <FileJson className="h-8 w-8 text-primary mb-4" />
            <h3 className="text-lg font-semibold mb-2">Structured Export</h3>
            <p className="text-muted-foreground text-sm">
              Export emails as Raw JSON, AI-Optimized JSON, or JSONL formats ready for ChatGPT and LLM fine-tuning.
            </p>
          </div>
          <div className="p-6 bg-card rounded-xl border shadow-sm">
            <Lock className="h-8 w-8 text-primary mb-4" />
            <h3 className="text-lg font-semibold mb-2">Read-Only Access</h3>
            <p className="text-muted-foreground text-sm">
              Strictly read-only permissions. We can only search and read your emails. No send or delete permissions required.
            </p>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center space-y-4 pt-8">
          <Button 
            size="lg" 
            className="text-lg px-8 h-14 w-full md:w-auto"
            onClick={() => window.location.href = "/api/auth/google"}
            data-testid="button-google-login"
          >
            Sign in with Google
            <ArrowRight className="ml-2 h-5 w-5" />
          </Button>
          <p className="text-sm text-muted-foreground">
            Secure authentication directly via Google.
          </p>
        </div>
      </div>
    </div>
  );
}
