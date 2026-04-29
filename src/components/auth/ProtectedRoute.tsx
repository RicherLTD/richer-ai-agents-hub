import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import type { ReactNode } from "react";

/**
 * Wraps protected routes. Three states:
 * 1. Loading (initial session check) → spinner
 * 2. No user → redirect to /login (preserving the intended destination)
 * 3. User → render children
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="טוען..." />
      </div>
    );
  }

  if (!user) {
    // Send the user to /login but remember where they wanted to go,
    // so we can bounce them back after a successful sign-in.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
