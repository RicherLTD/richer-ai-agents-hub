import { Users } from "lucide-react";

export function UsersTab() {
  return (
    <div className="rounded-md border border-dashed p-12 text-center">
      <Users className="mx-auto h-10 w-10 text-muted-foreground" />
      <h3 className="mt-3 text-sm font-medium">ניהול משתמשים יגיע ב-PR 11c</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        כולל הזמנת משתמשים חדשים, שינוי תפקיד (admin/user), והסרה.
      </p>
    </div>
  );
}
