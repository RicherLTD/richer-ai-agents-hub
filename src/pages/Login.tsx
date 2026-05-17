import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { Aurora } from "@/components/effects/Aurora";
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
    <div dir="rtl" className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      {/* Aurora hero — fills the top half, fades to canvas */}
      <Aurora className="!h-screen" />

      <div className="relative z-10 w-full max-w-sm">
        {/* Editorial wordmark above the card */}
        <p
          className="label-mono mb-4 text-center"
          dir="ltr"
        >
          Richer · WhatsApp AI Console
        </p>

        <div className="glass rounded-lg p-7">
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-md bg-primary-deep">
              <BrandLogo className="h-12 w-12" />
              <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
            </div>
            <div className="space-y-1">
              {/* Display serif heading — editorial gravitas */}
              <h1 className="font-display text-2xl font-medium tracking-tight text-foreground">
                ברוך הבא
              </h1>
              <p className="text-xs text-muted-foreground">התחבר כדי להמשיך</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">
                אימייל
              </Label>
              <div className="conic-focus rounded-md">
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  dir="ltr"
                  className="text-left font-mono"
                  placeholder="you@example.com"
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">
                סיסמה
              </Label>
              <div className="conic-focus rounded-md">
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  className="text-left font-mono"
                  disabled={submitting}
                />
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="mt-2 w-full glow-soft hover:glow"
              disabled={submitting || !email || !password}
            >
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

        <p className="label-mono mt-4 text-center !text-[10px]" dir="ltr">
          © Richer College · v2026.05
        </p>
      </div>
    </div>
  );
}

function translateAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) return "אימייל או סיסמה שגויים";
  if (lower.includes("email not confirmed")) return "האימייל לא אושר. בדוק את תיבת הדואר.";
  if (lower.includes("rate limit")) return "יותר מדי ניסיונות. נסה שוב בעוד רגע.";
  return message;
}
