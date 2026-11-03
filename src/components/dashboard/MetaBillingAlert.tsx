/**
 * MetaBillingAlert — banner at the top of the dashboard when Meta refuses the
 * active agent's template sends for a billing problem (error 131042).
 *
 * Shown on every tab on purpose: a payment issue stops ALL sends from the
 * number, so it must be impossible to miss, not one more line inside the
 * analytics tab. Admin-only, like the scheduled_messages rows it reads.
 */
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { he } from "date-fns/locale";
import { CircleCheck, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  BILLING_LOOKBACK_HOURS,
  META_PAYMENT_ISSUE_CODE,
  billingWarningState,
  getBillingSignal,
  type BillingSignal,
  type BillingWarning,
} from "@/lib/meta-billing";

const REFETCH_MS = 5 * 60_000;

function ago(iso: string | null): string {
  if (!iso) return "";
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: he });
}

export function MetaBillingAlertView({
  state,
  signal,
}: {
  state: BillingWarning;
  signal: BillingSignal;
}) {
  if (state === "none") return null;

  if (state === "recovered") {
    return (
      <Alert className="relative flex items-start gap-3 border-border bg-card/60 text-muted-foreground">
        <div className="mt-0.5 shrink-0">
          <CircleCheck className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <AlertTitle className="text-sm">בעיית התשלום מול Meta כנראה נפתרה</AlertTitle>
          <AlertDescription className="text-xs">
            היו {signal.refusals} חסימות תשלום ב-{BILLING_LOOKBACK_HOURS} השעות האחרונות, אבל טמפלייט
            נמסר {ago(signal.lastDeliveredAt)} — אחרי החסימה האחרונה.
          </AlertDescription>
        </div>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" className="relative flex items-start gap-3 bg-destructive/10">
      <div className="mt-0.5 shrink-0">
        <ShieldAlert className="h-5 w-5" />
      </div>
      <div className="space-y-1.5">
        <AlertTitle className="font-semibold">Meta חוסמת את השליחות מהמספר הזה — בעיית תשלום</AlertTitle>
        <AlertDescription className="space-y-1 text-sm">
          <p>
            {signal.refusals} טמפלייטים נחסמו ב-{BILLING_LOOKBACK_HOURS} השעות האחרונות עם קוד{" "}
            <span dir="ltr" className="tabular-nums">{META_PAYMENT_ISSUE_CODE}</span>, האחרון{" "}
            {ago(signal.lastRefusalAt)}.
          </p>
          <p>
            עד שאמצעי התשלום של חשבון ה-WhatsApp יתוקן ב-Meta Business Manager, אף טמפלייט מהמספר הזה
            לא יגיע ללידים.
          </p>
        </AlertDescription>
      </div>
    </Alert>
  );
}

export function MetaBillingAlert({ agentId }: { agentId: string }) {
  const q = useQuery({
    queryKey: ["meta-billing", agentId] as const,
    queryFn: () => getBillingSignal(agentId),
    refetchInterval: REFETCH_MS,
  });

  // A failed lookup stays silent: this banner is an extra safety net, and an
  // error box on top of every page would be noise. The funnel card still
  // shows the refusals.
  if (!q.data) return null;

  return <MetaBillingAlertView state={billingWarningState(q.data)} signal={q.data} />;
}
