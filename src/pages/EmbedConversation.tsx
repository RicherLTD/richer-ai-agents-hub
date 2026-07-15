import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchEmbedConversation, type EmbedConversation as Conv } from "@/lib/embed";

function formatTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

export default function EmbedConversation() {
  const [params] = useSearchParams();
  const [conv, setConv] = useState<Conv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const p = params.get("p") ?? "";
  const product = params.get("product") ?? "";
  const sig = params.get("sig") ?? "";

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchEmbedConversation({ p, product, sig })
      .then((d) => alive && (setConv(d), setError(null)))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [p, product, sig]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [conv]);

  return (
    <div dir="rtl" className="flex h-screen w-full flex-col bg-[#e7ddd3] font-sans">
      <header className="flex items-center justify-between gap-3 bg-[#0b6b5e] px-4 py-2.5 text-[#f2fbf8]">
        <span className="truncate font-bold">{conv?.lead?.name || "שיחה עם הליד"}</span>
        <span className="rounded-full bg-white/90 px-2.5 py-1 text-xs font-semibold text-[#0b6b5e]">
          🔒 צפייה בלבד
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
        {loading && <p className="mt-8 text-center text-sm text-[#5f7b73]">טוען שיחה…</p>}
        {error && (
          <p className="mt-8 text-center text-sm text-[#5f7b73]">
            לא ניתן לטעון את השיחה. רענן את הכרטיס.
          </p>
        )}
        {!loading && !error && conv && conv.messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-[#5f7b73]">עדיין אין שיחה עם הליד הזה.</p>
        )}
        {conv?.messages.map((m, i) => {
          const out = m.direction === "outbound";
          return (
            <div key={i} className={`flex ${out ? "justify-start" : "justify-end"}`}>
              <div
                className={`max-w-[78%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm shadow-sm ${
                  out ? "rounded-tl-sm bg-[#d9fdd3]" : "rounded-tr-sm bg-white"
                }`}
              >
                <span className="text-[#10231d]">{m.content?.trim() || "(הודעה ריקה)"}</span>
                <span className="mt-0.5 block text-left text-[10px] tabular-nums text-[#5f7b73]">
                  {formatTime(m.timestamp)}
                </span>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </main>

      <footer className="bg-[#f6f1ea] px-4 py-2.5 text-center text-xs font-semibold text-[#5f7b73]">
        🔒 צפייה בלבד — לא ניתן לשלוח הודעות מכאן
      </footer>
    </div>
  );
}
