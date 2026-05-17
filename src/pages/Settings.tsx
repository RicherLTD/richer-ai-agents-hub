import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminOnly } from "@/components/auth/AdminOnly";
import { AgentsTab } from "@/components/settings/AgentsTab";
import { DlqTab } from "@/components/settings/DlqTab";
import { UsersTab } from "@/components/settings/UsersTab";

const Settings = () => (
  <div className="space-y-6">
    <header className="space-y-2">
      <p className="label-mono" dir="ltr">Settings</p>
      <h1 className="font-display text-3xl font-medium tracking-tight">הגדרות</h1>
      <p className="text-sm text-muted-foreground">ניהול סוכנים, משתמשים ותקלות במערכת.</p>
    </header>

    <AdminOnly>
      <Tabs defaultValue="agents" dir="rtl">
        <TabsList className="inline-flex h-9 w-auto rounded-md border border-border bg-card/60 p-0.5 backdrop-blur">
          <TabsTrigger value="agents" className="rounded-sm px-3 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none">סוכנים</TabsTrigger>
          <TabsTrigger value="users" className="rounded-sm px-3 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none">משתמשים</TabsTrigger>
          <TabsTrigger value="dlq" className="rounded-sm px-3 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none">תקלות</TabsTrigger>
        </TabsList>
        <TabsContent value="agents" className="pt-4">
          <AgentsTab />
        </TabsContent>
        <TabsContent value="users" className="pt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="dlq" className="pt-4">
          <DlqTab />
        </TabsContent>
      </Tabs>
    </AdminOnly>
  </div>
);

export default Settings;
