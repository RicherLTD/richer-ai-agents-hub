import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuth } from "@/contexts/AuthContext";

interface AdminOnlyProps {
  children: ReactNode;
  /** Optional fallback to render for non-admins. Defaults to a permission alert. */
  fallback?: ReactNode;
}

/**
 * Renders children only when the current user has role='admin'. Used as a
 * UI guard around admin-only screens (Settings, agent edit forms, etc.).
 *
 * RLS still enforces the rule at the database level — this component only
 * keeps the UI honest and avoids surfacing controls the user can't action.
 */
export function AdminOnly({ children, fallback }: AdminOnlyProps) {
  const { isAdmin, isLoading } = useAuth();

  if (isLoading) return null;
  if (isAdmin) return <>{children}</>;

  if (fallback !== undefined) return <>{fallback}</>;

  return (
    <Alert variant="default" className="max-w-xl">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>אין לך גישה לדף זה</AlertTitle>
      <AlertDescription>הגדרות הסוכנים והמשתמשים זמינות לאדמינים בלבד.</AlertDescription>
    </Alert>
  );
}
