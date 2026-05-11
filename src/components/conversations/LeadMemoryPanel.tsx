import { Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { LeadMemory } from "@/types/message";

interface Field {
  label: string;
  value: string | number | null | undefined;
}

interface Props {
  memory: LeadMemory | null | undefined;
  isLoading: boolean;
}

function ValueOrDash({ value }: { value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span>{value}</span>;
}

export function LeadMemoryPanel({ memory, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!memory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <Sparkles className="h-6 w-6 text-muted-foreground/60" />
        <p>אין עדיין סיכום AI לשיחה הזו.</p>
        <p className="text-xs">הסיכום נכתב על ידי n8n אחרי שמספיק הודעות הצטברו.</p>
      </div>
    );
  }

  const questions: Field[] = [
    { label: "1. גיל", value: memory.q1_age },
    { label: "2. מה מניע אותך?", value: memory.q2_motivation },
    { label: "3. מה היית רוצה לשנות?", value: memory.q3_dream_change },
    { label: "4. מה עוצר אותך?", value: memory.q4_blocker },
    { label: "5. עד כמה זה דחוף?", value: memory.q5_urgency },
    { label: "6. השקעה אפשרית", value: memory.q6_investment },
  ];

  return (
    <div className="space-y-5 p-4">
      {memory.conversation_summary && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            סיכום AI
          </h3>
          <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
            {memory.conversation_summary}
          </p>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          6 השאלות
        </h3>
        <dl className="space-y-2 text-sm">
          {questions.map((q) => (
            <div key={q.label} className="grid grid-cols-[140px_1fr] items-baseline gap-2">
              <dt className="text-xs text-muted-foreground">{q.label}</dt>
              <dd className="break-words">
                <ValueOrDash value={q.value} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {memory.notes_for_advisor && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            הערות ליועץ
          </h3>
          <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
            {memory.notes_for_advisor}
          </p>
        </section>
      )}

      {memory.red_flags && memory.red_flags.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
            דגלים אדומים
          </h3>
          <ul className="list-disc space-y-1 ps-5 text-sm">
            {memory.red_flags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
          </ul>
        </section>
      )}

      {memory.promises_made && memory.promises_made.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            הבטחות שניתנו
          </h3>
          <ul className="list-disc space-y-1 ps-5 text-sm">
            {memory.promises_made.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
