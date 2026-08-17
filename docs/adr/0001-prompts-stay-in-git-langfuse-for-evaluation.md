---
status: accepted
date: 2026-07-28
---

# Prompts stay in git; Langfuse is for evaluation only

We use Langfuse for tracing and are adopting its evaluation layer (scores, LLM-as-judge evaluators, datasets/experiments), and Langfuse also offers prompt management with `production` labels — so a reader will reasonably wonder why our prompts are still markdown files synced into a Postgres table. The reason is that a prompt here is the text that carries legal and reputational constraints (no prices, no income promises, no AI self-disclosure) for messages sent to ~2,000 real leads a month, and today exactly one person edits prompts. Keeping prompts as files means every wording change is a reviewable, attributable, one-command-revertable pull request; Langfuse prompt management would let an unreviewed UI edit reach production immediately, which is a worse trade for us than the friction of a PR.

## Considered Options

- **Langfuse prompt management as source of truth** — rejected for now: no review gate before real leads, and prompt history would leave git. Worth revisiting if non-technical staff need to edit wording directly, since the friction of a PR then falls on the wrong person.
- **Hybrid: experiment in Langfuse, ship via git** — deferred. Attractive, but it is two systems to keep in sync and the existing one-system discipline has already slipped once (see below).

## Consequences

- The `prompts` table is a **runtime cache, not a source of truth**. A version that exists only in the table is drift, not a release.
- We must close the second door: `prompt-coach-apply` and the dashboard Rollback button write directly to the table, bypassing git. That is how `v19`/`v5` reached production on 2026-07-27 with no file, no PR, and `created_by = null`.
- `prompts:sync` deactivates every version of a prompt type and activates only the one named in `_active.json`. While DB-only versions exist, running it **silently reverts production** — v19 → v18. This is a landmine until drift is closed.
- CI should fail when the active DB prompt does not match the file named in `_active.json`. Without that check, this decision is unenforced and drift recurs.
- Any automated improvement loop must propose changes as a **pull request**, never as a direct write to the `prompts` table.
