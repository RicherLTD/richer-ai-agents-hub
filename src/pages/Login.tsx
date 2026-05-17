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
    <div dir="rtl" className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      {/* Ambient brand gradient — large, soft, very low-saturation.
          Anchored top-right, decorative, never gets in the way of content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -right-40 h-[42rem] w-[42rem] rounded-full bg-primary/15 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -left-40 h-[36rem] w-[36rem] rounded-full bg-primary/10 blur-[120px]"
      />

      <div className="relative w-full max-w-sm">
        {/* Top label — like Linear's login: small mono label above the card */}
        <p className="mb-3 text-center font-mono text-2xs uppercase tracking-[0.2em] text-muted-foreground" dir="ltr">
          Richer · WhatsApp AI Console
        </p>

        <div className="rounded-lg border border-border bg-card/80 p-7 backdrop-blur-sm">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-md bg-primary-deep">
              <BrandLogo className="h-12 w-12" />
              <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            </div>
            <div className="space-y-0.5">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">ברוך הבא</h1>
              <p className="text-xs text-muted-foreground">התחבר כדי להמשיך</p>
            </div>
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

        <p className="mt-4 text-center text-2xs text-muted-foreground/60" dir="ltr">
          © Richer College · v2026.05
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
