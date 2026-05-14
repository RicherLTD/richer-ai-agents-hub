import { BarChart3, Bot, FileText, Home, LogOut, MessageCircle, Settings, Users } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { NavLink } from "@/components/NavLink";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { AgentSelector } from "./AgentSelector";

interface NavItem {
  title: string;
  url: string;
  icon: typeof Home;
  end: boolean;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { title: "דף הבית", url: "/", icon: Home, end: true },
  { title: "לידים", url: "/leads", icon: Users, end: false },
  { title: "שיחות פעילות", url: "/conversations", icon: MessageCircle, end: false },
  { title: "ניתוחים", url: "/analytics", icon: BarChart3, end: false },
  { title: "ניהול Prompts", url: "/prompts", icon: FileText, end: false },
  { title: "מאמן הבוט", url: "/coach", icon: Bot, end: false, adminOnly: true },
  { title: "הגדרות", url: "/settings", icon: Settings, end: false },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const { user, appUser, isAdmin, signOut } = useAuth();
  const visibleNav = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
  const email = user?.email ?? "";
  const displayName = appUser?.full_name?.trim() || email;
  const initials = (appUser?.full_name?.trim() || email).slice(0, 2).toUpperCase() || "מנ";
  const roleLabel = isAdmin ? "אדמין" : appUser ? "משתמש" : "—";

  return (
    <Sidebar side="right" collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary-deep shadow-sm">
            <BrandLogo className="h-9 w-9" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight text-foreground">מערכת ריצ'ר AI</p>
              <p className="truncate text-[11px] text-muted-foreground">ניהול סוכני וואטסאפ</p>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <div className="pt-2">
          <AgentSelector />
        </div>

        <SidebarGroup>
          {!collapsed && <SidebarGroupLabel>ניווט</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleNav.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <NavLink
                      to={item.url}
                      end={item.end}
                      className="flex items-center gap-2.5 rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      activeClassName="bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
              aria-label="תפריט משתמש"
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary-soft text-primary text-xs font-semibold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              {!collapsed && (
                <div className="min-w-0 text-right">
                  <p className="truncate text-sm font-medium text-foreground">{displayName || "—"}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{roleLabel}</p>
                </div>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56" dir="rtl">
            <DropdownMenuLabel className="truncate" dir="ltr">
              {email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void signOut();
              }}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <LogOut className="ms-2 h-4 w-4" />
              התנתק
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
