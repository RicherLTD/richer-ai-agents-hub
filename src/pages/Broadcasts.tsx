import { useState } from "react";
import { AdminOnly } from "@/components/auth/AdminOnly";
import { BroadcastComposer } from "@/components/broadcasts/BroadcastComposer";
import { BroadcastList } from "@/components/broadcasts/BroadcastList";

export default function Broadcasts() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <AdminOnly>
      <div className="space-y-8 p-6" dir="rtl">
        <div>
          <h1 className="text-2xl font-bold">דיוור</h1>
          <p className="text-muted-foreground">שליחת הודעת template בתפוצה רחבה — מיידית או מתוזמנת.</p>
        </div>
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-lg font-semibold">דיוור חדש</h2>
          <BroadcastComposer onDone={() => setRefreshKey((k) => k + 1)} />
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-lg font-semibold">דיוורים אחרונים</h2>
          <BroadcastList key={refreshKey} />
        </section>
      </div>
    </AdminOnly>
  );
}
