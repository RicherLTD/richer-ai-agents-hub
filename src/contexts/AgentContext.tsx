import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Agent } from "@/types/agent";
import { getAgents } from "@/lib/agents";

const STORAGE_KEY = "richer:active-agent-id";

interface AgentContextValue {
  agents: Agent[];
  activeAgent: Agent | null;
  setActiveAgentId: (id: string) => void;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await getAgents();
      if (cancelledRef.current) return;
      setAgents(list);
      const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      setActiveAgentIdState((current) => {
        if (current && list.find((a) => a.id === current)) return current;
        return list.find((a) => a.id === stored)?.id ?? list[0]?.id ?? null;
      });
    } catch (err) {
      if (cancelledRef.current) return;
      console.error("Failed to load agents:", err);
      setAgents([]);
      setActiveAgentIdState(null);
    } finally {
      if (!cancelledRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

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
      refresh,
    }),
    [agents, activeAgentId, isLoading, refresh],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within AgentProvider");
  return ctx;
}
