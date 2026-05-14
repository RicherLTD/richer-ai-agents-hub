import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";

interface LocationState {
  from?: string;
}

export default function Login() {
  const { user, isLoading, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already logged in? Bounce to the originally-requested page (or home).
  if (!isLoading && user) {
    return <Navigate to={from} replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await signIn(email.trim(), password);
    setSubmitting(false);

    if (result.error) {
      setError(translateAuthError(result.error));
      return;
    }
    navigate(from, { replace: true });
  };

  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-secondary/40 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl bg-primary-deep shadow-sm">
            <BrandLogo className="h-14 w-14" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">מערכת ריצ'ר AI</h1>
          <p className="text-sm text-muted-foreground">התחבר כדי להמשיך</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">אימייל</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              dir="ltr"
              className="text-left"
              placeholder="you@example.com"
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">סיסמה</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              dir="ltr"
              className="text-left"
              disabled={submitting}
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <Button type="submit" className="mt-2 w-full" disabled={submitting || !email || !password}>
            {submitting ? (
              <>
                <Loader2 className="ms-2 h-4 w-4 animate-spin" />
                מתחבר...
              </>
            ) : (
              "התחבר"
            )}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          אין לך חשבון? פנה למנהל המערכת.
        </p>
      </div>
    </div>
  );
}

/**
 * Map the most common Supabase auth errors to Hebrew. Anything we don't
 * recognise falls through as the original message.
 */
function translateAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) return "אימייל או סיסמה שגויים";
  if (lower.includes("email not confirmed")) return "האימייל לא אושר. בדוק את תיבת הדואר.";
  if (lower.includes("rate limit")) return "יותר מדי ניסיונות. נסה שוב בעוד רגע.";
  return message;
}
