import { Outlet } from "react-router-dom";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { AppHeader } from "./AppHeader";
import { AgentProvider } from "@/contexts/AgentContext";

export function AppLayout() {
  return (
    <AgentProvider>
      <SidebarProvider>
        <div dir="rtl" className="flex min-h-screen w-full bg-secondary/40">
          <AppSidebar />
          <SidebarInset className="flex flex-1 flex-col bg-background">
            <AppHeader />
            <main className="flex-1 p-4 md:p-6 lg:p-8">
              <Outlet />
            </main>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </AgentProvider>
  );
}
