import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminOnly } from "@/components/auth/AdminOnly";
import { AgentsTab } from "@/components/settings/AgentsTab";
import { UsersTab } from "@/components/settings/UsersTab";

const Settings = () => (
  <div className="space-y-6">
    <header>
      <h1 className="text-2xl font-bold">הגדרות</h1>
      <p className="text-sm text-muted-foreground">ניהול סוכנים ומשתמשים במערכת.</p>
    </header>

    <AdminOnly>
      <Tabs defaultValue="agents" dir="rtl">
        <TabsList>
          <TabsTrigger value="agents">סוכנים</TabsTrigger>
          <TabsTrigger value="users">משתמשים</TabsTrigger>
        </TabsList>
        <TabsContent value="agents" className="pt-4">
          <AgentsTab />
        </TabsContent>
        <TabsContent value="users" className="pt-4">
          <UsersTab />
        </TabsContent>
      </Tabs>
    </AdminOnly>
  </div>
);

export default Settings;
