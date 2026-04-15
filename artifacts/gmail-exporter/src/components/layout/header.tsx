import { Link } from "wouter";
import { useGetAuthUser, useLogout } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Database, History, Search, LogOut, MailSearch } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function Header() {
  const { data: user } = useGetAuthUser();
  const logout = useLogout();

  if (!user) return null;

  return (
    <header className="border-b bg-background sticky top-0 z-40 h-14 flex items-center px-4 justify-between">
      <div className="flex items-center gap-6">
        <Link href="/search" className="flex items-center gap-2 font-bold text-primary" data-testid="link-logo">
          <MailSearch className="h-5 w-5" />
          <span>Gmail Query Exporter</span>
        </Link>

        <nav className="flex items-center gap-1">
          <Link href="/search" className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md hover:bg-accent text-muted-foreground hover:text-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground" data-testid="link-nav-search">
            <Search className="h-4 w-4" />
            Search
          </Link>
          <Link href="/saved-searches" className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md hover:bg-accent text-muted-foreground hover:text-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground" data-testid="link-nav-saved">
            <Database className="h-4 w-4" />
            Saved Searches
          </Link>
          <Link href="/export-history" className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md hover:bg-accent text-muted-foreground hover:text-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground" data-testid="link-nav-history">
            <History className="h-4 w-4" />
            Export History
          </Link>
        </nav>
      </div>

      <div className="flex items-center gap-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-8 w-8 rounded-full" data-testid="button-user-menu">
              <Avatar className="h-8 w-8 border">
                <AvatarImage src={user.picture} alt={user.name || user.email} />
                <AvatarFallback>{user.name?.charAt(0) || user.email.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">{user.name}</p>
                <p className="text-xs leading-none text-muted-foreground">
                  {user.email}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem 
              onClick={() => logout.mutate(undefined, { onSuccess: () => window.location.href = "/" })}
              className="text-destructive focus:text-destructive cursor-pointer"
              data-testid="button-logout"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
