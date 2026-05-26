# implement-plan — AI Developer Guide

This is a TypeScript CLI tool that orchestrates Claude Code agents to execute multi-phase implementation plans.

## Architecture

```
src/
  run.ts            CLI entry — parses args, registers SIGINT, dispatches to execute or validate
  plan-parser.ts    Extracts phases: YAML block from markdown, returns typed Phase[]
  plan-validator.ts Structural validation without execution — the `validate` subcommand
  stream-parser.ts  Parses --output-format stream-json events from a ChildProcess, tees to terminal
  phase-runner.ts   Executes serial and parallel phases; manages git worktrees
  prompt-builder.ts Builds agent prompts with context injection and completion-via-file rule
  context-loader.ts Reads CLAUDE.md and source files from target project to inject into prompts
  model-selector.ts Scores phase complexity to auto-select haiku vs sonnet
```

## Key Invariants

**Completion detection** uses a file `.phase-complete.json` written by the agent, not stdout scanning. The orchestrator checks `readCompletion(path, phaseId)` which validates both existence and `phase === phaseId && verified === true`. Never change this to string scanning.

**Parallel phase file merge** uses `copyFiles(srcDir, dstDir, files)` — copies specific files from each worktree, then `git add . && git commit`. This avoids `git merge` conflicts since teammates own disjoint file sets (enforced by `validateNoFileOverlap`).

**Retry context** includes the actual verify command output (stdout + stderr) from `captureVerify()`. Always pass `lastVerifyOutput` into the next attempt's `failureContext` — vague retry prompts ("try a different approach") don't work.

**Real-time output** is handled by `parseStreamWithTee` which buffers incomplete lines and prints assistant text events with a caller-supplied prefix. The buffer handles chunk boundaries correctly — do not simplify this to `chunk.toString().split('\n')`.

## Adding a New Validation Check

Add to `src/plan-validator.ts` in `validateSerialPhase` or `validateParallelPhase`. Push to `errors` (blocks execution) or `warnings` (advisory). Checks in `validatePlan` at the top level apply to all phases.

## Adding a New Model

Add the alias to `MODEL_ALIAS` in `src/phase-runner.ts`, to `VALID_MODELS` in `src/plan-validator.ts`, and to the `ModelName` union in `src/plan-parser.ts`. Use the short model alias (e.g. `'haiku'`, `'sonnet-next'`), not a full model ID — Claude Code resolves aliases to the current latest version of that tier. Full IDs are only needed when pinning to a specific snapshot for reproducibility.

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
If any flag we use is gone or renamed, update `callClaude()` in `src/phase-runner.ts`.

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

**Model tiering by complexity**
Mechanical tasks (file creation, migrations) → haiku. Logic tasks (service implementation, tests, algorithms) → sonnet. Never auto-select opus on a rate-limited plan. See `model-selector.ts` for the scoring heuristic.

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
