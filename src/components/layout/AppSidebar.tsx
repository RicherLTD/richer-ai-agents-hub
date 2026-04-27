import { BarChart3, FileText, Home, MessageCircle, Settings, Sparkles, Users } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { AgentSelector } from "./AgentSelector";

const NAV_ITEMS = [
  { title: "דף הבית", url: "/", icon: Home, end: true },
  { title: "לידים", url: "/leads", icon: Users, end: false },
  { title: "שיחות פעילות", url: "/conversations", icon: MessageCircle, end: false },
  { title: "ניתוחים", url: "/analytics", icon: BarChart3, end: false },
  { title: "ניהול Prompts", url: "/prompts", icon: FileText, end: false },
  { title: "הגדרות", url: "/settings", icon: Settings, end: false },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <Sidebar side="right" collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary-deep to-primary-light text-primary-foreground shadow-sm">
            <Sparkles className="h-4 w-4" />
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
              {NAV_ITEMS.map((item) => (
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
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary-soft text-primary text-xs font-semibold">מנ</AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">מנהל מערכת</p>
              <p className="truncate text-[11px] text-muted-foreground">admin@richer.ac.il</p>
            </div>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
