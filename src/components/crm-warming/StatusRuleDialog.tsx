import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MAX_WARMING_INSTRUCTIONS,
  ruleToDraft,
  validateStatusRuleDraft,
  type CrmStatusRuleRow,
  type StatusRuleDraft,
} from "@/lib/crm-warming";

interface Props {
  rule: CrmStatusRuleRow | null;
  onClose: () => void;
  onSave: (draft: StatusRuleDraft) => Promise<void>;
  isSaving: boolean;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

/**
 * Edit one `crm_status_rules` row. `warming_instructions` is the field that
 * actually changes bot behaviour, so it gets the bulk of the dialog; the
 * numeric knobs sit underneath it.
 */
export function StatusRuleDialog({ rule, onClose, onSave, isSaving }: Props) {
  const [draft, setDraft] = useState<StatusRuleDraft | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    setDraft(rule ? ruleToDraft(rule) : null);
    setShowErrors(false);
  }, [rule]);

  const errors = draft ? validateStatusRuleDraft(draft) : {};
  const hasErrors = Object.keys(errors).length > 0;

  const patch = (next: Partial<StatusRuleDraft>) =>
    setDraft((current) => (current ? { ...current, ...next } : current));

  const handleSave = async () => {
    if (!draft) return;
    if (hasErrors) {
      setShowErrors(true);
      return;
    }
    await onSave(draft);
  };

  return (
    <Dialog open={Boolean(rule)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>
            עריכת כלל — סטטוס <span className="tabular-nums">{rule?.status_sub}</span>
          </DialogTitle>
          <DialogDescription>
            ההנחיות נכנסות ל-prompt של הבוט כשהליד עונה לפנייה. השינוי נכנס לתוקף מיד — בלי deploy
            ובלי אישור תבנית ב-Meta.
          </DialogDescription>
        </DialogHeader>

        {draft && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rule-label">שם הסטטוס *</Label>
                <Input
                  id="rule-label"
                  value={draft.status_label}
                  onChange={(e) => patch({ status_label: e.target.value })}
                  placeholder="למשל: יקר לי"
                />
                {showErrors && <FieldError message={errors.status_label} />}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-objection">מפתח התנגדות (אנגלית) *</Label>
                <Input
                  id="rule-objection"
                  dir="ltr"
                  value={draft.objection_key}
                  onChange={(e) => patch({ objection_key: e.target.value })}
                  placeholder="price"
                />
                {showErrors && <FieldError message={errors.objection_key} />}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="rule-instructions">הנחיות לבוט *</Label>
                <span
                  className={cn(
                    "text-[11px] tabular-nums text-muted-foreground",
                    draft.warming_instructions.length > MAX_WARMING_INSTRUCTIONS &&
                      "text-destructive",
                  )}
                  dir="ltr"
                >
                  {draft.warming_instructions.length} / {MAX_WARMING_INSTRUCTIONS}
                </span>
              </div>
              <Textarea
                id="rule-instructions"
                rows={12}
                value={draft.warming_instructions}
                onChange={(e) => patch({ warming_instructions: e.target.value })}
                placeholder="איך הבוט צריך להתנהג מול ליד שהגיע מהסטטוס הזה — מה להדגיש, ממה להימנע, ומה המטרה של השיחה."
                className="min-h-[220px] leading-relaxed"
              />
              {showErrors && <FieldError message={errors.warming_instructions} />}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rule-delay">השהיה לפני פנייה (שעות)</Label>
                <Input
                  id="rule-delay"
                  type="number"
                  min={0}
                  max={720}
                  dir="ltr"
                  value={draft.delay_hours}
                  onChange={(e) => patch({ delay_hours: Number(e.target.value) })}
                />
                {showErrors && <FieldError message={errors.delay_hours} />}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-cooldown">צינון בין פניות (ימים)</Label>
                <Input
                  id="rule-cooldown"
                  type="number"
                  min={0}
                  max={365}
                  dir="ltr"
                  value={draft.cooldown_days}
                  onChange={(e) => patch({ cooldown_days: Number(e.target.value) })}
                />
                {showErrors && <FieldError message={errors.cooldown_days} />}
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="rule-active">הכלל פעיל</Label>
                  <p className="text-xs text-muted-foreground">
                    כשכבוי — אירועי הסטטוס עדיין נרשמים, אבל לא נשלחת פנייה.
                  </p>
                </div>
                <Switch
                  id="rule-active"
                  checked={draft.is_active}
                  onCheckedChange={(checked) => patch({ is_active: checked })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="rule-clears-zoom">מנקה מצב זום</Label>
                  <p className="text-xs text-muted-foreground">
                    הסטטוס הזה מבטל זום קיים ומחזיר את הליד למשפך.
                  </p>
                </div>
                <Switch
                  id="rule-clears-zoom"
                  checked={draft.clears_zoom_state}
                  onCheckedChange={(checked) => patch({ clears_zoom_state: checked })}
                />
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="flex-row-reverse gap-2 sm:flex-row-reverse">
          <Button type="button" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? "שומר..." : "שמור"}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            ביטול
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
