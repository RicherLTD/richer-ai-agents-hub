---
status: accepted
date: 2026-07-29
---

# Three data classes, split at First Inbound — and only Bot Quality Data may drive prompt changes

We classify all funnel data as **Reach Data** (did the message physically arrive), **Marketing Data** (right message / right person / right time → did it earn a First Inbound), or **Bot Quality Data** (everything after First Inbound), and we rule that **prompt changes may only be driven by Bot Quality Data**. The reason is a measurement discovered on 2026-07-29: of 6,337 template messages sent, only 3,629 were delivered — **43% never arrived** — while among leads who did read a message, 57% replied. Without this split, a Meta deliverability problem reads as a bad prompt: the aggregate "didn't reply" bucket mixes leads who were never reached with leads who read the message and chose not to answer, and tuning the agent's wording cannot possibly fix the former.

## Consequences

- A "did not reply" number is **meaningless unless decomposed** into `never delivered` / `delivered unread` / `read but ignored`. Each has a different owner and a different fix: Meta reputation and phone-number hygiene, send timing, and copy respectively.
- The weekly statistics page must present the three classes as separate blocks, never as one funnel column.
- The improvement loop may not propose a prompt change on evidence drawn from Reach or Marketing Data. Conversely, template and scheduling changes may not be justified by Bot Quality Data.
- Deliverability work (Meta error codes `131049` throttling, `131026` undeliverable, `131047` re-engagement window) is tracked as its own workstream, not as bot improvement, even though it currently has a larger expected payoff than any prompt change.
- Reach Data currently lives in the wrong place: `meta_status_sent/delivered/read` are written as rows in `error_logs`, where they make up ~77% of the table and bury real errors. Reach Data needs its own home before the statistics page can be built honestly.
