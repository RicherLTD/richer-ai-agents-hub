import { format } from "date-fns";
import { he } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Prompt } from "@/types/prompt";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "d בMMM yyyy, HH:mm", { locale: he });
}

interface Props {
  prompt: Prompt | null;
  onClose: () => void;
}

export function PromptViewDialog({ prompt, onClose }: Props) {
  return (
    <Dialog open={Boolean(prompt)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span dir="ltr" className="font-mono">
              {prompt?.prompt_type}
            </span>
            <Badge variant="secondary" dir="ltr">
              {prompt?.version}
            </Badge>
            {prompt?.is_active && <Badge>פעיל</Badge>}
          </DialogTitle>
          <DialogDescription>נוצר ב-{formatDate(prompt?.created_at ?? null)}</DialogDescription>
        </DialogHeader>

        {prompt?.notes && (
          <section className="rounded-md border bg-muted/40 p-3 text-sm">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              הערות
            </h3>
            <p className="whitespace-pre-wrap">{prompt.notes}</p>
          </section>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md border">
          <pre className="whitespace-pre-wrap break-words p-4 text-xs leading-relaxed" dir="ltr">
            {prompt?.content}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}
