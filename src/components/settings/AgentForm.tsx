import { zodResolver } from "@hookform/resolvers/zod";
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
import { Textarea } from "@/components/ui/textarea";
import type { Agent, AgentInsert, AgentStatus, AgentUpdate } from "@/types/agent";

const STATUS_OPTIONS: Array<{ value: AgentStatus; label: string }> = [
  { value: "active", label: "פעיל" },
  { value: "paused", label: "מושהה" },
  { value: "archived", label: "בארכיון" },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

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
    });
    await onSubmit(payload as AgentInsert | AgentUpdate);
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
