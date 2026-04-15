import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useEffect, useState } from "react";
import { SearchFields, useGetLabels, useCreateSavedSearch, getGetSavedSearchesQueryKey } from "@workspace/api-client-react";
import { buildGmailQuery } from "@/lib/build-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Save, Search } from "lucide-react";

const searchFormSchema = z.object({
  keywords: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  hasWords: z.string().optional(),
  doesNotHave: z.string().optional(),
  label: z.string().optional(),
  exactPhrase: z.string().optional(),
  hasAttachment: z.boolean().default(false),
  onlyUnread: z.boolean().default(false),
  onlyStarred: z.boolean().default(false),
  includeSpamTrash: z.boolean().default(false),
  maxResults: z.coerce.number().min(1).max(500).default(50),
});

export type SearchFormValues = z.infer<typeof searchFormSchema>;

interface SearchFormProps {
  onSearch: (query: string, values: SearchFormValues) => void;
  isLoading: boolean;
}

export function SearchForm({ onSearch, isLoading }: SearchFormProps) {
  const { data: labelsData } = useGetLabels();
  const createSavedSearch = useCreateSavedSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [liveQuery, setLiveQuery] = useState("");
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  const form = useForm<SearchFormValues>({
    resolver: zodResolver(searchFormSchema),
    defaultValues: {
      keywords: "",
      from: "",
      to: "",
      subject: "",
      hasWords: "",
      doesNotHave: "",
      label: "none",
      exactPhrase: "",
      hasAttachment: false,
      onlyUnread: false,
      onlyStarred: false,
      includeSpamTrash: false,
      maxResults: 50,
    },
  });

  const values = form.watch();

  useEffect(() => {
    const q = buildGmailQuery({
      ...values,
      label: values.label === "none" ? undefined : values.label,
    });
    setLiveQuery(q);
  }, [values]);

  const onSubmit = (data: SearchFormValues) => {
    onSearch(liveQuery, data);
  };

  const handleSaveSearch = () => {
    if (!saveName.trim()) return;
    
    createSavedSearch.mutate({
      data: {
        name: saveName,
        query: liveQuery,
        fields: { ...values, label: values.label === "none" ? undefined : values.label } as SearchFields
      }
    }, {
      onSuccess: () => {
        toast({ description: "Search saved successfully" });
        setSaveModalOpen(false);
        setSaveName("");
        queryClient.invalidateQueries({ queryKey: getGetSavedSearchesQueryKey() });
      },
      onError: () => {
        toast({ variant: "destructive", description: "Failed to save search" });
      }
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="keywords"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Keywords</FormLabel>
                <FormControl>
                  <Input placeholder="Enter keywords..." {...field} data-testid="input-keywords" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Accordion type="single" collapsible className="w-full" defaultValue="advanced">
            <AccordionItem value="advanced">
              <AccordionTrigger className="text-sm font-medium">Advanced Filters</AccordionTrigger>
              <AccordionContent className="space-y-4 pt-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="from"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>From</FormLabel>
                        <FormControl>
                          <Input placeholder="sender@..." {...field} data-testid="input-from" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="to"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>To</FormLabel>
                        <FormControl>
                          <Input placeholder="recipient@..." {...field} data-testid="input-to" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="subject"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Subject</FormLabel>
                      <FormControl>
                        <Input placeholder="Words in subject" {...field} data-testid="input-subject" />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="hasWords"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Has the words</FormLabel>
                        <FormControl>
                          <Input placeholder="Includes..." {...field} data-testid="input-has-words" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="doesNotHave"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Doesn't have</FormLabel>
                        <FormControl>
                          <Input placeholder="Excludes..." {...field} data-testid="input-does-not-have" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Label</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-label">
                            <SelectValue placeholder="Select a label" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Any label</SelectItem>
                          {labelsData?.labels.map((label) => (
                            <SelectItem key={label.id} value={label.id}>
                              {label.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />

                <div className="space-y-3 pt-2">
                  <FormField
                    control={form.control}
                    name="hasAttachment"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                        <FormControl>
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} data-testid="checkbox-has-attachment" />
                        </FormControl>
                        <FormLabel className="font-normal">Has attachment</FormLabel>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="onlyUnread"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                        <FormControl>
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} data-testid="checkbox-only-unread" />
                        </FormControl>
                        <FormLabel className="font-normal">Only unread</FormLabel>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="includeSpamTrash"
                    render={({ field }) => (
                      <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                        <FormControl>
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} data-testid="checkbox-include-spam-trash" />
                        </FormControl>
                        <FormLabel className="font-normal">Include spam/trash</FormLabel>
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="maxResults"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Results</FormLabel>
                      <FormControl>
                        <Input type="number" min={1} max={500} {...field} data-testid="input-max-results" />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        <div className="bg-muted p-3 rounded-md space-y-2 border">
          <Label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Generated Query</Label>
          <div className="font-mono text-sm break-all" data-testid="text-live-query">
            {liveQuery || "*"}
          </div>
        </div>

        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={isLoading} data-testid="button-run-search">
            <Search className="mr-2 h-4 w-4" />
            {isLoading ? "Searching..." : "Search"}
          </Button>
          
          <Dialog open={saveModalOpen} onOpenChange={setSaveModalOpen}>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" size="icon" disabled={!liveQuery} data-testid="button-open-save-modal">
                <Save className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Save Search</DialogTitle>
                <DialogDescription>
                  Save this search query to easily run it again later.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="save-name">Name</Label>
                  <Input 
                    id="save-name" 
                    placeholder="e.g. Invoices from Acme Corp" 
                    value={saveName} 
                    onChange={e => setSaveName(e.target.value)}
                    data-testid="input-save-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Query</Label>
                  <div className="text-sm font-mono bg-muted p-2 rounded break-all">{liveQuery}</div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSaveModalOpen(false)}>Cancel</Button>
                <Button onClick={handleSaveSearch} disabled={!saveName.trim() || createSavedSearch.isPending} data-testid="button-confirm-save">
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </form>
    </Form>
  );
}
