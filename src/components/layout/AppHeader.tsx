import { Moon, Sun } from "lucide-react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
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

  const entry =
    PAGE_TITLES[location.pathname] ??
    Object.entries(PAGE_TITLES)
      .filter(([k]) => k !== "/" && location.pathname.startsWith(k))
      .map(([, v]) => v)[0] ??
    PAGE_TITLES["/"];

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-xl md:px-6">
      <SidebarTrigger className="text-muted-foreground transition-colors hover:text-foreground" />

      {/* Title block — display serif + mono sub-label */}
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="font-display truncate text-lg font-medium tracking-tight text-foreground">
          {entry.title}
        </h1>
        {entry.sub && (
          <span className="label-mono hidden !text-[10px] sm:inline" dir="ltr">
            {entry.sub}
          </span>
        )}
      </div>

      <div className="me-auto flex items-center gap-1.5 md:gap-2">
        {activeAgent && (
          <div
            className="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground sm:inline-flex"
            title={`סוכן פעיל — ${activeAgent.display_name}`}
          >
            <span className="presence-dot" />
            <span className="hidden md:inline">{activeAgent.display_name}</span>
          </div>
        )}

        {/* Future home for cmd+K — visible affordance even before wired */}
        <kbd
          className="label-mono hidden h-7 select-none items-center gap-1 rounded-md border border-border bg-card/60 px-2 !text-[10px] !tracking-wider text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground md:inline-flex"
          title="חיפוש מהיר (בקרוב)"
          dir="ltr"
        >
          ⌘K
        </kbd>

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
