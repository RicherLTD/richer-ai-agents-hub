import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { listBroadcastTemplates } from "@/lib/broadcasts";
import type { Agent, AgentInsert, AgentStatus, AgentUpdate } from "@/types/agent";

const STATUS_OPTIONS: Array<{ value: AgentStatus; label: string }> = [
  { value: "active", label: "פעיל" },
  { value: "paused", label: "מושהה" },
  { value: "archived", label: "בארכיון" },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Radix Select can't hold an empty string value, so "no template" needs a sentinel. */
const NO_TEMPLATE = "__none__";

const DEFAULT_WARMING_CONTEXT_DAYS = 14;

const agentSchema = z.object({
  name: z
    .string()
    .min(1, "שדה חובה")
    .max(64, "מקסימום 64 תווים")
    .regex(/^[a-z0-9_-]+$/i, "אותיות לטיניות, מספרים, קו תחתון או מקף בלבד"),
  display_name: z.string().min(1, "שדה חובה").max(120, "מקסימום 120 תווים"),
  description: z.string().max(500, "מקסימום 500 תווים").optional().or(z.literal("")),
  status: z.enum(["active", "paused", "archived"]),
  whatsapp_number: z.string().max(40).optional().or(z.literal("")),
  whatsapp_provider: z.string().max(40).optional().or(z.literal("")),
  brand_color: z
    .string()
    .optional()
    .refine((v) => !v || HEX_RE.test(v), "פורמט HEX, למשל #451470")
    .or(z.literal("")),
  primary_goal: z.string().max(1000, "מקסימום 1000 תווים").optional().or(z.literal("")),
  icon_url: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\//.test(v), "חייב להתחיל ב-http:// או https://")
    .or(z.literal("")),
  // --- CRM warming (migration 0046) ---
  crm_warming_enabled: z.boolean(),
  warming_template_name: z.string().max(200).optional().or(z.literal("")),
  warming_template_language: z.string().max(16).optional().or(z.literal("")),
  warming_context_days: z.coerce
    .number({ invalid_type_error: "מספר שלם" })
    .int("מספר שלם")
    .min(1, "לפחות יום אחד")
    .max(365, "מקסימום 365 ימים"),
});

export type AgentFormValues = z.infer<typeof agentSchema>;

const EMPTY: AgentFormValues = {
  name: "",
  display_name: "",
  description: "",
  status: "active",
  whatsapp_number: "",
  whatsapp_provider: "",
  brand_color: "",
  primary_goal: "",
  icon_url: "",
  crm_warming_enabled: false,
  warming_template_name: "",
  warming_template_language: "he",
  warming_context_days: DEFAULT_WARMING_CONTEXT_DAYS,
};

function fromAgent(agent: Agent): AgentFormValues {
  return {
    name: agent.name,
    display_name: agent.display_name,
    description: agent.description ?? "",
    status: agent.status ?? "active",
    whatsapp_number: agent.whatsapp_number ?? "",
    whatsapp_provider: agent.whatsapp_provider ?? "",
    brand_color: agent.brand_color ?? "",
    primary_goal: agent.primary_goal ?? "",
    icon_url: agent.icon_url ?? "",
    crm_warming_enabled: agent.crm_warming_enabled ?? false,
    warming_template_name: agent.warming_template_name ?? "",
    warming_template_language: agent.warming_template_language ?? "he",
    warming_context_days: agent.warming_context_days ?? DEFAULT_WARMING_CONTEXT_DAYS,
  };
}

function blankToNull<T extends Record<string, unknown>>(v: T): T {
  const out = { ...v };
  for (const k of Object.keys(out) as Array<keyof T>) {
    if (out[k] === "") out[k] = null as T[keyof T];
  }
  return out;
}

interface AgentFormProps {
  agent?: Agent;
  onSubmit: (values: AgentInsert | AgentUpdate) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export function AgentForm({ agent, onSubmit, onCancel, submitLabel }: AgentFormProps) {
  const form = useForm<AgentFormValues>({
    resolver: zodResolver(agentSchema),
    defaultValues: agent ? fromAgent(agent) : EMPTY,
  });
  const isEdit = Boolean(agent);

  // Warming opener uses a Meta-approved template, same registry the broadcast
  // composer reads. On create there is no agent id yet, so the picker waits.
  const templates = useQuery({
    queryKey: ["broadcast-templates", agent?.id ?? ""] as const,
    queryFn: () => listBroadcastTemplates(agent!.id),
    enabled: Boolean(agent?.id),
  });

  const handleSubmit = form.handleSubmit(async (values) => {
    const payload = blankToNull({
      name: values.name,
      display_name: values.display_name,
      description: values.description,
      status: values.status,
      whatsapp_number: values.whatsapp_number,
      whatsapp_provider: values.whatsapp_provider,
      brand_color: values.brand_color,
      primary_goal: values.primary_goal,
      icon_url: values.icon_url,
      // Nullable — clearing the picker really does mean "no template".
      warming_template_name: values.warming_template_name,
    });
    // These three are NOT NULL in migration 0046, so they bypass blankToNull:
    // an empty language must fall back to the column default, never to NULL.
    const warmingPayload = {
      crm_warming_enabled: values.crm_warming_enabled,
      warming_template_language: values.warming_template_language?.trim() || "he",
      warming_context_days: values.warming_context_days,
    };
    await onSubmit({ ...payload, ...warmingPayload } as AgentInsert | AgentUpdate);
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="display_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>שם תצוגה *</FormLabel>
                <FormControl>
                  <Input placeholder="שיווק שותפים — האחים סיטון" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>מזהה (slug) *</FormLabel>
                <FormControl>
                  <Input placeholder="affiliate_marketing" disabled={isEdit} {...field} />
                </FormControl>
                <FormDescription>משמש בקוד ובסנכרון Prompts. לא ניתן לעדכן אחרי יצירה.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>תיאור</FormLabel>
              <FormControl>
                <Textarea rows={2} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>סטטוס *</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="brand_color"
            render={({ field }) => (
              <FormItem>
                <FormLabel>צבע מותג</FormLabel>
                <FormControl>
                  <Input placeholder="#451470" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="whatsapp_number"
            render={({ field }) => (
              <FormItem>
                <FormLabel>מספר WhatsApp</FormLabel>
                <FormControl>
                  <Input placeholder="+972XX-XXXXXXX" dir="ltr" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="whatsapp_provider"
            render={({ field }) => (
              <FormItem>
                <FormLabel>ספק WhatsApp</FormLabel>
                <FormControl>
                  <Input placeholder="360dialog / wati / …" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="primary_goal"
          render={({ field }) => (
            <FormItem>
              <FormLabel>מטרה ראשית</FormLabel>
              <FormControl>
                <Textarea rows={2} placeholder="תיאום זום עם יועץ לימודים + ליקוט 5 שאלות" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="icon_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>אייקון (URL)</FormLabel>
              <FormControl>
                <Input dir="ltr" placeholder="https://…" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* ── CRM warming ─────────────────────────────────────────────
            Its own bordered block so the kill switch here is never confused
            with the agent-level "השהה" pause: pausing takes the whole bot
            offline, this only stops proactive CRM warming. */}
        <div className="space-y-4 rounded-md border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">חימום לידים מה-CRM</h3>
          </div>

          <FormField
            control={form.control}
            name="crm_warming_enabled"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border border-border bg-card p-3">
                <div className="space-y-1">
                  <FormLabel>חימום CRM פעיל</FormLabel>
                  <FormDescription>
                    מתג ראשי לחימום בלבד. כשהוא כבוי — אירועי סטטוס מה-CRM עדיין נרשמים ונראים בדף
                    "חימום CRM", אבל לא נשלחת שום פנייה. <strong>אינו</strong> משהה את הבוט: מענה
                    לשיחות רגילות ממשיך כרגיל (לשם כך יש "השהה" ברשימת הסוכנים).
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-label="חימום CRM פעיל"
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormField
              control={form.control}
              name="warming_template_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>תבנית פתיחה</FormLabel>
                  <Select
                    value={field.value || NO_TEMPLATE}
                    onValueChange={(value) => {
                      if (value === NO_TEMPLATE) {
                        field.onChange("");
                        return;
                      }
                      field.onChange(value);
                      const picked = templates.data?.find((t) => t.name === value);
                      if (picked) form.setValue("warming_template_language", picked.language);
                    }}
                    disabled={!isEdit || templates.isLoading}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="בחר תבנית…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_TEMPLATE}>ללא תבנית</SelectItem>
                      {(templates.data ?? []).map((t) => (
                        <SelectItem key={t.id} value={t.name}>
                          {t.label} ({t.name})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {isEdit
                      ? "מתוך תבניות הדיוור המאושרות של הסוכן (הגדרות ← תבניות דיוור)."
                      : "ניתן לבחור תבנית אחרי יצירת הסוכן."}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="warming_context_days"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>חלון הקשר (ימים)</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} max={365} dir="ltr" {...field} />
                  </FormControl>
                  <FormDescription>
                    כמה ימים אחורה מהשיחה הקודמת נטענים ל-prompt של הבוט. ברירת מחדל:{" "}
                    {DEFAULT_WARMING_CONTEXT_DAYS}.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            ביטול
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "שומר..." : (submitLabel ?? "שמור")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
