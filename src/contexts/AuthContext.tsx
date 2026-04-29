import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { getCurrentAppUser } from "@/lib/users";
import type { AppUser } from "@/types/user";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  appUser: AppUser | null;
  isAdmin: boolean;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshAppUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const cancelledRef = useRef(false);

  const loadAppUser = useCallback(async (forUserId: string | undefined) => {
    if (!forUserId) {
      setAppUser(null);
      return;
    }
    try {
      const row = await getCurrentAppUser();
      if (cancelledRef.current) return;
      setAppUser(row);
    } catch (err) {
      if (cancelledRef.current) return;
      console.error("Failed to load app_users row:", err);
      setAppUser(null);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;

    // 1. Read the current session synchronously from local storage
    //    (Supabase persists it). This avoids a flash of "logged-out" state
    //    on app load when the user is actually still authenticated.
    void supabase.auth.getSession().then(async ({ data }) => {
      if (cancelledRef.current) return;
      setSession(data.session);
      await loadAppUser(data.session?.user.id);
      if (cancelledRef.current) return;
      setIsLoading(false);
    });

    // 2. Subscribe to future changes (sign-in, sign-out, token refresh, etc.).
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (cancelledRef.current) return;
      setSession(newSession);
      void loadAppUser(newSession?.user.id);
      setIsLoading(false);
    });

    return () => {
      cancelledRef.current = true;
      subscription.subscription.unsubscribe();
    };
  }, [loadAppUser]);

  const signIn = async (email: string, password: string): Promise<{ error: string | null }> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signOut = async (): Promise<void> => {
    await supabase.auth.signOut();
  };

  const refreshAppUser = useCallback(async () => {
    await loadAppUser(session?.user.id);
  }, [loadAppUser, session?.user.id]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      session,
      appUser,
      isAdmin: appUser?.role === "admin",
      isLoading,
      signIn,
      signOut,
      refreshAppUser,
    }),
    [session, appUser, isLoading, refreshAppUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
