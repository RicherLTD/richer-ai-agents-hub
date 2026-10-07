# CRM-warming simulator

Plays a scripted "lead" against the real warming prompt, status rules and guards, grades every conversation, and writes one report. It replaces hours of live WhatsApp testing with one run that a human reviews afterwards.

## Safety

- It never sends a WhatsApp message and never calls HookMyApp, Mooz, Fireberry or Make.
- It never writes to the database. Database access is the Supabase Management API with SELECT statements only; `db.ts` rejects anything else before a request is made (tested).
- Network targets: `api.supabase.com` (reads) and Anthropic. Nothing else.
- Secrets are only read from the env file you pass. They are never printed, logged or written to the reports.

## Run

Add the Anthropic key to the env file once (a full run needs it, `--dry-run` does not):

```
ANTHROPIC_API_KEY=sk-ant-...
```

The env file also needs `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN`. Pass its path; the simulator does not copy it anywhere.

```bash
# full simulation: all scenarios
~/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env \
  scripts/admin/warming-sim/main.ts --env-file "<path to .env.local>"

# a cheap first try (about $1-2)
... --env-file "<path>" --only 22,23

# no Anthropic calls: only load from the DB and write the assembled prompts
... --env-file "<path>" --dry-run
```

`--allow-write` is needed for the report; everything else is the same as the usual Deno flags.

Open `scripts/admin/warming-sim/out/report.html` (a JSON twin is `report.json`). `out/` is git-ignored.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--env-file <path>` | required | env file with the keys above |
| `--only 22,23` | all | scenario ids (`x-23-already-said`) or status numbers (`23` runs every scenario of that status) |
| `--max-cost-usd` | 25 | the run stops cleanly once spend reaches this; unfinished scenarios are marked "aborted" and the report is still written |
| `--concurrency` | 4 | scenarios in parallel |
| `--dry-run` | off | write assembled system prompts to `out/dry-run/` and stop |
| `--scenarios <file>` | `scenarios.json` | alternative scenario file |
| `--out <dir>` | `scripts/admin/warming-sim/out` | output directory |

Scenarios for statuses that are disabled in the database are skipped automatically; active statuses with no scenario are listed as a warning.

## What it does per scenario

1. Builds the system prompt the way `whatsappWebhookHandler.ts` does for a warming lead: date header, booking block (empty), warming block, active main prompt, brain section. It reuses `renderWarmingContextBlock`, `splitTurnHistory`, `buildPriorProfile`, `findOpenerTemplateName`, `buildBrainSection` and `buildGuardHint` from production. The history starts with the opener `[template:warming_1]`, with an earlier hidden conversation behind it (so `hasHistory` is true).
2. A Claude lead actor (Sonnet 4.6) plays the persona and beats from `scenarios.json`, one beat per message, up to `maxTurns`. It never picks a meeting time and ends when the bot says a clear goodbye.
3. The bot answers with the production call: `claude-sonnet-4-6`, adaptive thinking, `max_tokens` 2048, Mooz tool definitions, cacheable system block.
4. The reply goes through `validateAgentReply` and `judgeReply` (Haiku 4.5) with the single guard-hint retry. Warming turns also run `withWarmingReplyGuard` exactly as the handler does. Two rejections means the fixed apology goes out, recorded as `FALLBACK (guard: <reason>)`. Dashes (`—`, `–`) become `-`.
5. A grader (Sonnet 4.6, forced tool call) scores 12 cross-status criteria plus the scenario's must / must-not items, with a short Hebrew quote as evidence, and gives PASS / BORDERLINE / FAIL. A silence forces `no_silence` to fail and the verdict to FAIL; a failed check never sits under PASS.

## What is and is not faithful to production

Faithful: prompt text and order, model and parameters, tool definitions, guards, the guard-retry loop, the dash sanitizer, the status rules / opener / brain / main prompt (all read live from the DB), prompt caching on the system block.

Not faithful:

- **Tools are stubs.** `list_available_slots` returns two invented slots tomorrow at 11:00 and 11:30 Israel time, `book_meeting` always succeeds. Each call shows in the transcript as `[tool: ... lead_requested_booking=true|false]`. The production dispatcher also applies a qualification gate (reads `lead_memory`) and a Fireberry gate; neither is simulated, so the bot can book earlier than in production. Judge that from the `lead_requested_booking` flag shown in the transcript.
- **A separate tool loop, not `runAgentTurn`.** `runAgentTurn` dispatches through `dispatchMoozTool`, which reads and writes the database, and making it injectable would touch production code. The simulator's loop in `botTurn.ts` follows it line by line (5 iterations, same params, same retry helper).
- **Fallback.** After two guard rejections the lead gets production's fixed apology (recorded as `FALLBACK (guard: <reason>)`, skipped when it was already the last thing sent, as in the handler). The grader counts it, like silence, as a failure.
- **The lead is an LLM**, not a person. It is consistent but less surprising than a human tester.
- **No memory extraction.** `lead_memory` is not updated between turns; the prior profile comes from `priorMemory` in the scenario (empty by default). CRM primary status (`statusMain`) and rep notes are not set.
- **The date header is mirrored**, not imported: it is built inline in the handler (the `const dateHeader` block, ~lines 1257-1273). If that changes, update `buildDateHeader` in `promptAssembly.ts`.
- **Opener** is always the generic `warming_1`. Per-status openers (plan stage 5) do not exist yet in production either.
- **Time** is the wall clock at run start; the same `now` is used for the whole run.

## Cost per full run

There was no Anthropic key while this was built, so **no real token counts exist**; the numbers below are an estimate to be replaced by the first real run (the report header shows real tokens and dollars).

Basis, from the `--dry-run` against the live DB (main prompt v20, 13 brain documents):

- Assembled system prompt: about 164,000 characters (about 96,000 Hebrew letters), of which the brain is about 138,000 characters. At roughly 2.5 characters per token for this Hebrew-heavy text that is about 60-70K tokens (unverified).
- Per scenario with about 6 lead turns (about 7 bot calls including tool rounds): one cache write (65K x $3.75/M, about $0.25), about six cache reads plus about 1.5K output tokens each (about $0.045 each), lead actor (about $0.04), grader (about $0.05), judge (under $0.01). That is about **$0.6 per scenario**.
- 31 scenarios: **about $15-25** with caching working (cache lasts 5 minutes and is refreshed on every use; the prefix differs per status, so scenarios do not share it).
- Without cache hits the same run would be about $45, above the default `--max-cost-usd` of 25, so the guard would stop it. If a first run shows cache read tokens near zero in the report header, stop and look before running everything.

Suggested order: `--only 22,23` first (about $1-2), read the report, then the full run.

## Tests

```bash
~/.bun/bin/bun run test      # includes scripts/admin/warming-sim/*.test.ts
~/.deno/bin/deno check scripts/admin/warming-sim/main.ts
```

The root `tsc --noEmit` does not include `scripts/`; `deno check` is the type check for this code.
