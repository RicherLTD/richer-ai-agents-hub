import { Moon, Sun } from "lucide-react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { BrandLogo } from "@/components/BrandLogo";
import { useAgent } from "@/contexts/AgentContext";
import { useTheme } from "@/hooks/use-theme";

const PAGE_TITLES: Record<string, { title: string; sub?: string }> = {
  "/":              { title: "דף הבית",          sub: "Overview" },
  "/leads":         { title: "לידים",             sub: "Leads" },
  "/conversations": { title: "שיחות פעילות",      sub: "Conversations" },
  "/prompts":       { title: "ניהול Prompts",     sub: "Prompts" },
  "/coach":         { title: "מאמן הבוט",         sub: "Coach" },
  "/settings":      { title: "הגדרות",            sub: "Settings" },
};

export function AppHeader() {
  const location = useLocation();
  const { activeAgent } = useAgent();
  const { theme, toggle } = useTheme();

  // Match longest prefix so /coach, /coach/foo, /settings/x all land
  // on their parent header entry.
  const entry =
    PAGE_TITLES[location.pathname] ??
    Object.entries(PAGE_TITLES)
      .filter(([k]) => k !== "/" && location.pathname.startsWith(k))
      .map(([, v]) => v)[0] ??
    PAGE_TITLES["/"];

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 md:px-6">
      <SidebarTrigger className="text-muted-foreground transition-colors hover:text-foreground" />

      {/* Title block — bilingual: large Hebrew, small mono English label */}
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
          {entry.title}
        </h1>
        {entry.sub && (
          <span className="hidden font-mono text-2xs uppercase tracking-wider text-muted-foreground/70 sm:inline" dir="ltr">
            {entry.sub}
          </span>
        )}
      </div>

      <div className="me-auto flex items-center gap-1.5 md:gap-2">
        {activeAgent && (
          <div
            className="hidden items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover sm:inline-flex"
            title={`סוכן פעיל — ${activeAgent.display_name}`}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-success/50" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            <BrandLogo className="h-3.5 w-3.5" />
            <span className="hidden md:inline">{activeAgent.display_name}</span>
          </div>
        )}

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggle}
          className="h-8 w-8 rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          aria-label={theme === "dark" ? "מצב יום" : "מצב לילה"}
          title={theme === "dark" ? "מעבר למצב יום" : "מעבר למצב לילה"}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
