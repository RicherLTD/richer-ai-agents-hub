import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/contexts/AuthContext";
import { getAllAppUsers } from "@/lib/users";
import { deleteUser, inviteUser, updateUserRole } from "@/lib/users-admin";
import type { AppRole, AppUser } from "@/types/user";
import { InviteUserDialog } from "./InviteUserDialog";
import { UserRoleBadge } from "./UserRoleBadge";

const QUERY_KEY = ["admin", "app_users"] as const;
const DATE_FORMATTER = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : DATE_FORMATTER.format(d);
}

export function UsersTab() {
  const { user: currentAuthUser } = useAuth();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<AppUser | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getAllAppUsers,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const inviteMutation = useMutation({
    mutationFn: inviteUser,
    onSuccess: (res) => {
      toast.success(`הזמנה נשלחה ל-${res.email}`);
      setInviting(false);
      void invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: AppRole }) => updateUserRole(id, role),
    onSuccess: () => {
      toast.success("התפקיד עודכן");
      void invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      toast.success("המשתמש הוסר");
      setConfirmingDelete(null);
      void invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">שגיאה בטעינת משתמשים: {error.message}</p>;
  }

  const list = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">משתמשים</h2>
          <p className="text-sm text-muted-foreground">{list.length} משתמשים במערכת</p>
        </div>
        <Button onClick={() => setInviting(true)}>
          <UserPlus className="ms-2 h-4 w-4" />
          הזמן משתמש
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>שם</TableHead>
              <TableHead>אימייל</TableHead>
              <TableHead>תפקיד</TableHead>
              <TableHead>נוצר ב</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  אין משתמשים. לחץ על "הזמן משתמש" כדי להוסיף את הראשון.
                </TableCell>
              </TableRow>
            ) : (
              list.map((u) => {
                const isSelf = u.id === currentAuthUser?.id;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      {u.full_name?.trim() || "—"}
                      {isSelf && <span className="ms-2 text-[11px] text-muted-foreground">(את/ה)</span>}
                    </TableCell>
                    <TableCell dir="ltr">{u.email}</TableCell>
                    <TableCell>
                      <UserRoleBadge role={u.role} />
                    </TableCell>
                    <TableCell>{formatDate(u.created_at)}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="פעולות">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {u.role === "admin" ? (
                            <DropdownMenuItem
                              disabled={isSelf || roleMutation.isPending}
                              onSelect={() => roleMutation.mutate({ id: u.id, role: "user" })}
                            >
                              הפוך למשתמש רגיל
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={roleMutation.isPending}
                              onSelect={() => roleMutation.mutate({ id: u.id, role: "admin" })}
                            >
                              הפוך לאדמין
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isSelf}
                            onSelect={() => setConfirmingDelete(u)}
                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                          >
                            הסר משתמש
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <InviteUserDialog
        open={inviting}
        onOpenChange={setInviting}
        onSubmit={(payload) => inviteMutation.mutateAsync(payload)}
      />

      <AlertDialog
        open={Boolean(confirmingDelete)}
        onOpenChange={(open) => !open && setConfirmingDelete(null)}
      >
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>להסיר את {confirmingDelete?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              הפעולה תמחק את המשתמש לצמיתות מ-Auth. ניתן להזמין אותו מחדש בעתיד עם אותו אימייל.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmingDelete && deleteMutation.mutate(confirmingDelete.id)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "מסיר..." : "הסר"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
