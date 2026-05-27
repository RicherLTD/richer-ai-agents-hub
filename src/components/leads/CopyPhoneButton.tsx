import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Props {
  phone: string;
  /** Extra classes — typically the group-hover reveal matching the parent row's group name. */
  className?: string;
}

/**
 * Copies a lead's phone to the clipboard. Stops event propagation so it works
 * inside clickable rows (conversation list / leads table) without triggering
 * row navigation. Hidden on desktop until the row is hovered (via the parent's
 * group class), always visible on touch where there is no hover.
 */
export function CopyPhoneButton({ phone, className }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      toast.success("הטלפון הועתק");
    } catch {
      toast.error("ההעתקה נכשלה");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
      aria-label="העתק מספר טלפון"
      title="העתק מספר טלפון"
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:text-foreground",
        "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "opacity-100 sm:opacity-0",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}
