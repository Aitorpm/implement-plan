# implement-plan — AI Developer Guide

This is a TypeScript CLI tool that orchestrates Claude Code agents to execute multi-phase implementation plans.

## Architecture

```
src/
  run.ts              CLI entry — parses args, registers SIGINT, dispatches to execute or validate
  plan-parser.ts      Extracts phases: YAML block from markdown, returns typed Phase[]
  plan-validator.ts   Structural validation without execution — the `validate` subcommand
  stream-parser.ts    Re-exports from providers/ for backwards compatibility
  phase-runner.ts     Executes serial and parallel phases; manages git worktrees; provider failover
  prompt-builder.ts   Builds agent prompts with context injection and completion-via-file rule
  context-loader.ts   Reads CLAUDE.md / AGENTS.md and source files from target project to inject into prompts
  model-selector.ts     Scores phase complexity + prior context size to auto-select haiku/sonnet/opus (returns ModelTier)
  provider-selector.ts  Scores phase task signals to auto-select claude vs codex per phase
  providers/
    types.ts          Provider interface, ModelTier, ProviderResult
    claude.ts         Claude Code provider — stream-json parsing, spawn flags
    codex.ts          OpenAI Codex provider — JSONL parsing, git diff for filesWritten
    registry.ts       Phase-scoped + session rate limit tracking, waitForAvailable()
```

## Key Invariants

**Completion detection** uses a file `.phase-complete.json` written by the agent, not stdout scanning. The orchestrator checks `readCompletion(path, phaseId)` which validates both existence and `phase === phaseId && verified === true`. Never change this to string scanning.

**Parallel phase file merge** uses `copyFiles(srcDir, dstDir, files)` — copies specific files from each worktree, then `git add . && git commit`. This avoids `git merge` conflicts since teammates own disjoint file sets (enforced by `validateNoFileOverlap`).

**Retry context** includes the actual verify command output (stdout + stderr) from `captureVerify()`. Always pass `lastVerifyOutput` into the next attempt's `failureContext` — vague retry prompts ("try a different approach") don't work.

**Clean workdir before retry** — `runSerial` runs `git reset --hard HEAD && git clean -fd` at the start of every attempt > 1. This prevents partial writes from attempt N from confusing attempt N+1. Never skip this step.

**Prior-phase context injection** — after each phase, `run.ts` accumulates all changed files (via `git diff --name-only HEAD~1 HEAD` + `result.filesWritten`). The next phase receives these as `priorPhaseFiles`, injected under "ACTUAL OUTPUT FROM PRIOR PHASES (source of truth)". This is the primary fix for downstream agents writing against the plan spec instead of the actual output. Capped at 40,000 chars; schema/constants/types files are priority-sorted to the top (`loadPriorPhaseFiles` in `context-loader.ts`).

**Spec-compliance reviewer** — after each serial phase's verify passes, `reviewPhaseOutput()` spawns a fast (Haiku) agent with Read/Glob/Write tools. It reads the changed files, checks each plan task for spec adherence (field names, constants, wiring tasks), and writes `.phase-review.json`. If `passed: false` and retries remain, issues are injected as `failureContext` for the next attempt. On the last attempt, issues are logged as warnings but the phase still succeeds — the reviewer is a quality aid, not a hard gate.

**Real-time output** is handled by `parseStreamWithTee` which buffers incomplete lines and prints assistant text events with a caller-supplied prefix. The buffer handles chunk boundaries correctly — do not simplify this to `chunk.toString().split('\n')`.

## Adding a New Validation Check

Add to `src/plan-validator.ts` in `validateSerialPhase` or `validateParallelPhase`. Push to `errors` (blocks execution) or `warnings` (advisory). Checks in `validatePlan` at the top level apply to all phases.

## Adding a New Model

Add the alias to `modelMap` in the relevant provider class (`src/providers/claude.ts` or `src/providers/codex.ts`), to `VALID_MODELS` in `src/plan-validator.ts`, and to the `ModelName` union in `src/plan-parser.ts`. Use the short model alias (e.g. `'haiku'`, `'sonnet-next'`), not a full model ID — Claude Code resolves aliases to the current latest version of that tier. Full IDs are only needed when pinning to a specific snapshot for reproducibility.

Users can also override model maps at runtime via `~/.implement-plan.json` — no recompile needed:
```json
{
  "codex": { "sonnet": "gpt-5.5" },
  "claude": { "opus": "claude-opus-4-8" }
}
```

## Provider System

The tool supports Claude Code (`claude`) and OpenAI Codex (`codex`) as interchangeable backends.

**Failover is phase-scoped, not session-sticky**: at the start of each phase, `registry.nextPhase()` clears per-phase rate-limit flags so Claude is tried first again. If Claude is rate-limited mid-phase, Codex takes over for that phase. The next phase tries Claude first again. This is the standard pattern from production AI orchestrators.

**When both providers are simultaneously exhausted**: `waitForAvailable(abortSignal)` pauses and polls every 5 minutes, printing `⏳ Both providers rate-limited. Resuming at HH:MM (~N min)`. SIGINT during the wait is honored via AbortController.

### Adding a New Provider

1. Create `src/providers/<name>.ts` implementing the `Provider` interface from `types.ts`
2. Implement `isInstalled()`, `spawn()`, `parseStream()`, `detectRateLimit()`
3. Add the class to `setupProviders()` in `src/run.ts`
4. Add the provider name to `VALID_PROVIDERS` in `src/plan-validator.ts`
5. Add to the `ProviderName` union in `src/plan-parser.ts`

### Rate Limit Detection

The regex used in both providers to detect rate limiting:
```
/rate.?limit|too many requests|429|quota exceeded|throttl|concurrency limit|resource exhausted/i
```
Apply this to `stderr + result.error` in `detectRateLimit()`.

### Codex-specific Notes

Codex CLI flags: `codex exec -m <model> --sandbox danger-full-access --json --ephemeral -C <workDir> <prompt>`
- `--json`: JSONL structured output — one JSON object per line
- `--ephemeral`: no session persistence between phases
- `-C`: sets working directory
- `--sandbox danger-full-access`: allows filesystem writes (required for file creation tasks)
- No `--allowedTools` equivalent — filesystem isolation comes from the worktree directory itself
- No per-invocation cost reporting — `costUsd` is always 0 in `ProviderResult`
- `filesWritten` is derived from `git diff --name-only HEAD` after the process closes

## Stream-JSON Event Format

Claude Code `--output-format stream-json` emits newline-delimited JSON. Relevant event types:
- `{type: "result", subtype: "success"|"error_max_turns"|..., total_cost_usd, num_turns}` — final summary
- `{type: "assistant", message: {content: [{type: "text", text: "..."}]}}` — model output
- `{type: "tool_use", name: "Write"|"Edit"|..., input: {file_path: "..."}}` — tool invocation

## TypeScript Conventions

- Strict mode on — no `any` except in stream parsing (external JSON)
- No classes — plain functions and interfaces only
- `execSync` for git and verify commands (synchronous is fine — these are intentionally blocking)
- `spawn` for claude processes (must be async — long-running)
- Errors bubble up via `throw` in library code; caught and formatted in `run.ts`

---

## Dependency Policy — Always Use Latest Stable

**This project must always run on the latest stable versions of every dependency.**
When you modify any file, first check that all deps are current. If `npm outdated` shows anything behind, update it before proceeding.

```bash
npm outdated          # shows what's behind
npm view <pkg> version  # check a specific package's latest
npm update            # update within current semver ranges
npm install <pkg>@latest  # update past major version boundaries
npm run build         # verify it compiles after updating
```

### Per-package upgrade notes

**TypeScript** (`typescript`, `@types/node`)
- Check for major versions at https://www.typescriptlang.org/docs/handbook/release-notes/overview.html
- TypeScript 6+ requires `"types": ["node"]` explicitly in `tsconfig.json` — node globals are no longer auto-included
- After any TypeScript major bump: run `npm run build` and fix all new strict errors before anything else
- `@types/node` major version should track the Node.js current LTS (Node 22 LTS → `@types/node@22.x`, Node 24 LTS → `@types/node@24.x`)

**tsx** (dev runner, replaced ts-node)
- Always prefer `tsx` over `ts-node` — tsx uses esbuild, requires no tsconfig CJS/ESM workarounds, starts in ~200ms vs ~2s
- No configuration needed: `tsx src/run.ts` just works

**js-yaml**
- Never use the removed `yaml.safeLoad()` / `yaml.safeDump()` (removed in v4) — use `yaml.load()` / `yaml.dump()` with the `FAILSAFE_SCHEMA` or `JSON_SCHEMA` option when loading untrusted input
- Always pass `{ schema: yaml.DEFAULT_SCHEMA }` explicitly for predictable parsing

### Claude Code CLI — flags to verify on each upgrade

Run `claude --version` and `claude --help` after any `claude` CLI update. These flags have changed between versions and will change again:

| Flag | Status | Notes |
|------|--------|-------|
| `--permission-mode bypassPermissions` | ✅ Current | Replaced `--dangerously-skip-permissions` |
| `--bare` | ✅ Current | Skips hooks, auto-memory, CLAUDE.md discovery — always use in orchestration |
| `--max-budget-usd` | ✅ Current | Hard cost cap per invocation — always set this |
| `--output-format stream-json` | ✅ Current | Required for stream parsing |
| `--allowedTools` / `--allowed-tools` | ✅ Current | Both spellings accepted |
| `--dangerously-skip-permissions` | ⚠️ Deprecated | Still works but prefer `--permission-mode bypassPermissions` |
| `--max-turns` | ❌ Does not exist | Was silently ignored — use `--max-budget-usd` instead |
| `--model haiku` / `--model sonnet` | ✅ Current | Short aliases resolve to latest; prefer over full IDs |

**How to audit after a CLI upgrade:**
```bash
claude --help | grep -E "model|permission|budget|bare|turns|output"
```
If any flag we use is gone or renamed, update `spawn()` in `src/providers/claude.ts`.

### Model names — never hardcode full IDs

Use short aliases (`haiku`, `sonnet`, `opus`) not full model IDs (`claude-haiku-4-5-20251001`). Aliases always resolve to the current production version of that tier. Full IDs go stale when Anthropic releases new model versions.

When Anthropic releases a new model tier (e.g. `claude-sonnet-5`), add it as an alias in `MODEL_ALIAS` in `phase-runner.ts`. The `claude --model` flag documents available aliases via `claude --help`.

---

## AI Orchestration Best Practices

These are the patterns this codebase uses — maintain them when extending the tool.

**Completion via file, never string scanning**
Agents write `.phase-complete.json` with `{phase, verified: true}`. Scanning stdout for magic strings like `TASK_COMPLETE` false-positives on "I cannot output TASK_COMPLETE" — file existence is unambiguous.

**Two-layer verification**
Agent self-verifies before writing the completion file. Orchestrator runs verify commands again independently. This catches agents that write `.phase-complete.json` prematurely.

**Retry with actual error output**
Never retry with vague prompts ("try a different approach"). Always inject the exact stdout+stderr from the failed verify command into the next attempt's prompt. Agents can't fix errors they can't see.

**Real-time tee with line buffering**
Stream chunks don't align with JSON line boundaries. Buffer incomplete lines in `lineBuffer` and process only on `\n`. Never call `chunk.toString().split('\n')` directly.

**Model tiering by complexity and context size**
Three tiers — `fast` (Haiku), `standard` (Sonnet), `powerful` (Opus). Auto-selection in `model-selector.ts` scores each phase on:

- *Haiku signals* (-1 each): `create file`, `scaffold`, `migrate`, `rename`, `copy`, ≤3 tasks, grep-only verify
- *Sonnet signals* (+2 each): `implement`, `algorithm`, `service`, `engine`, `state machine`, `streaming`, test suites, ≥5 tasks, parallel mode; +1 per `.spec.ts`/`.test.ts`/`engine.ts`/`service.ts` in file list
- *Opus signals* (+4 each): `agent`, `orchestrat`, `llm`, `multi-agent`, `tool call`; `.agent.ts`/`.tool.ts` in file list
- *Hard floors*: 7+ tasks → minimum Sonnet (score ≥ 3); prior context > 8k chars → minimum Sonnet; prior context > 25k chars → +3 additional (large prompts degrade Haiku quality significantly)

Thresholds: score ≥ 8 → Opus · score ≥ 3 → Sonnet · else → Haiku.

The prior-context floor is the key guard: because prompts now carry up to 40k chars of prior-phase output, any non-first phase with meaningful context automatically routes to Sonnet minimum. Haiku is only used for truly isolated mechanical phases with no prior context.

**Budget cap per phase**
Always pass `--max-budget-usd` to every claude invocation. This is the only real guard against runaway costs — there is no `--max-turns` flag. Scale the budget proportionally to the phase timeout.

**`--bare` for orchestrated agents**
Agents spawned by the orchestrator should always run with `--bare`. Without it, Claude Code auto-discovers the project's CLAUDE.md (which we inject ourselves), runs hooks, and writes to its own memory — all of which interfere with deterministic orchestration.

**File ownership in parallel phases**
Teammates must own completely disjoint file sets. Validate this before spawning (`validateNoFileOverlap`). Copy files from worktrees directly (`copyFiles`) instead of using `git merge` to avoid conflicts — teammates own non-overlapping files so direct copy is always safe.

---

## Testing

```bash
# Validate examples parse correctly
npm run build
./dist/run.js validate examples/test-serial.md
./dist/run.js validate examples/test-parallel.md

# Smoke test without claude calls
cd /tmp && git init smoke-test && cd smoke-test
implement-plan ~/Documents/Workspace/implement-plan/examples/test-serial.md --dry-run
```
