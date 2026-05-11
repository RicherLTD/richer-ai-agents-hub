import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import type { InviteUserPayload } from "@/lib/users-admin";

const schema = z.object({
  email: z.string().min(1, "שדה חובה").email("כתובת אימייל לא תקינה"),
  full_name: z.string().max(120, "מקסימום 120 תווים").optional().or(z.literal("")),
  role: z.enum(["admin", "user"]),
});

type Values = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: InviteUserPayload) => Promise<void>;
}

export function InviteUserDialog({ open, onOpenChange, onSubmit }: Props) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", full_name: "", role: "user" },
  });

  const handle = form.handleSubmit(async (values) => {
    await onSubmit({
      email: values.email.trim(),
      role: values.role,
      full_name: values.full_name?.trim() || undefined,
    });
    form.reset();
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>הזמנת משתמש חדש</DialogTitle>
          <DialogDescription>
            המשתמש יקבל מייל עם קישור להגדרת סיסמה. שדה חובה מסומן ב-*.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={handle} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>אימייל *</FormLabel>
                  <FormControl>
                    <Input dir="ltr" type="email" placeholder="user@example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="full_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>שם מלא</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormDescription>אופציונלי. ייצג את המשתמש ב-sidebar.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>תפקיד *</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="user">משתמש (קריאה + ניהול שיחות)</SelectItem>
                      <SelectItem value="admin">אדמין (כולל ניהול סוכנים ומשתמשים)</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                ביטול
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "שולח..." : "שלח הזמנה"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
