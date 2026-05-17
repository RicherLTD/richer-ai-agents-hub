import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminOnly } from "@/components/auth/AdminOnly";
import { AgentsTab } from "@/components/settings/AgentsTab";
import { DlqTab } from "@/components/settings/DlqTab";
import { UsersTab } from "@/components/settings/UsersTab";

const Settings = () => (
  <div className="space-y-6">
    <header>
      <h1 className="text-2xl font-bold">הגדרות</h1>
      <p className="text-sm text-muted-foreground">ניהול סוכנים, משתמשים ותקלות.</p>
    </header>

    <AdminOnly>
      <Tabs defaultValue="agents" dir="rtl">
        <TabsList>
          <TabsTrigger value="agents">סוכנים</TabsTrigger>
          <TabsTrigger value="users">משתמשים</TabsTrigger>
          <TabsTrigger value="dlq">תקלות</TabsTrigger>
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
