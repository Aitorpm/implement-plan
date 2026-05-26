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

Add to `MODEL_MAP` in `src/phase-runner.ts` and to `VALID_MODELS` in `src/plan-validator.ts`. Update the `ModelName` type in `src/plan-parser.ts`.

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
