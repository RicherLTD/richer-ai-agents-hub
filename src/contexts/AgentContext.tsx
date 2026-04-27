import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Agent } from "@/types/agent";
import { getAgents } from "@/lib/agents";

const STORAGE_KEY = "richer:active-agent-id";

interface AgentContextValue {
  agents: Agent[];
  activeAgent: Agent | null;
  setActiveAgentId: (id: string) => void;
  isLoading: boolean;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getAgents().then((list) => {
      if (cancelled) return;
      setAgents(list);
      const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      const initial = list.find((a) => a.id === stored)?.id ?? list[0]?.id ?? null;
      setActiveAgentIdState(initial);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setActiveAgentId = (id: string) => {
    setActiveAgentIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, id);
  };

  const value = useMemo<AgentContextValue>(
    () => ({
      agents,
      activeAgent: agents.find((a) => a.id === activeAgentId) ?? null,
      setActiveAgentId,
      isLoading,
    }),
    [agents, activeAgentId, isLoading],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within AgentProvider");
  return ctx;
}
