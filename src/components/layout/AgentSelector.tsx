import { useAgent } from "@/contexts/AgentContext";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useState } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";

export function AgentSelector() {
  const { agents, activeAgent, setActiveAgentId } = useAgent();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  if (collapsed) {
    return (
      <div className="flex justify-center py-2" aria-label={activeAgent?.display_name ?? "סוכן"}>
        <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-primary-deep">
          <BrandLogo className="h-9 w-9" />
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 pb-2">
      <p className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">סוכן פעיל</p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-auto w-full justify-between gap-2 rounded-lg border-border bg-card px-3 py-2.5 text-right hover:bg-primary-soft hover:border-primary/30"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary-deep">
                <BrandLogo className="h-7 w-7" />
              </span>
              <span className="truncate text-sm font-medium text-foreground">
                {activeAgent?.display_name ?? "בחר סוכן"}
              </span>
            </div>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[260px] p-0" align="start">
          <Command>
            <CommandInput placeholder="חיפוש סוכן..." className="text-right" />
            <CommandList>
              <CommandEmpty>לא נמצאו סוכנים</CommandEmpty>
              <CommandGroup heading="סוכנים זמינים">
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={agent.display_name}
                    onSelect={() => {
                      setActiveAgentId(agent.id);
                      setOpen(false);
                    }}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: agent.brand_color ?? undefined }}
                      />
                      <span className="truncate">{agent.display_name}</span>
                    </div>
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        activeAgent?.id === agent.id ? "opacity-100 text-primary" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    setOpen(false);
                    toast({ title: "בקרוב", description: "הוספת סוכן חדש תיפתח בשלב הבא" });
                  }}
                  className="text-primary"
                >
                  <Plus className="ms-1 h-4 w-4" />
                  הוסף סוכן חדש
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
