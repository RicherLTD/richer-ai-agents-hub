import { Bell, Search } from "lucide-react";
import { useLocation } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { BrandLogo } from "@/components/BrandLogo";
import { useAgent } from "@/contexts/AgentContext";

const PAGE_TITLES: Record<string, string> = {
  "/": "דף הבית",
  "/leads": "לידים",
  "/conversations": "שיחות פעילות",
  "/analytics": "ניתוחים",
  "/prompts": "ניהול Prompts",
  "/settings": "הגדרות",
};

export function AppHeader() {
  const location = useLocation();
  const { activeAgent } = useAgent();
  const title = PAGE_TITLES[location.pathname] ?? "דף הבית";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground" />

      <h1 className="text-xl font-semibold text-foreground md:text-2xl">{title}</h1>

      <div className="me-auto flex items-center gap-2 md:gap-3">
        <div className="relative hidden md:block">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="חיפוש..."
            className="h-9 w-56 rounded-lg bg-secondary pe-9 text-sm border-transparent focus-visible:bg-background focus-visible:border-border"
          />
        </div>

        {activeAgent && (
          <Badge
            variant="outline"
            className="hidden gap-1.5 rounded-full border-primary/20 bg-primary-soft py-1 ps-3 pe-2.5 text-xs font-medium text-primary sm:inline-flex"
          >
            <BrandLogo className="h-3.5 w-3.5" />
            <span>מטפל בסוכן: {activeAgent.display_name}</span>
          </Badge>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="rounded-lg text-muted-foreground hover:text-foreground"
          aria-label="התראות"
        >
          <Bell className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
