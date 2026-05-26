# implement-plan

Autonomous plan orchestrator for Claude Code and OpenAI Codex. Reads a YAML plan embedded in a markdown file and drives agents headlessly through each phase, with self-verification, cost tracking, and automatic provider failover.

## Install

```bash
cd ~/Documents/Workspace/implement-plan
npm install && npm run build && npm link
```

`implement-plan` is now available globally.

## Guided Mode (Recommended)

Describe what you want to build — the tool generates a plan, lets you review it, and executes it:

```bash
cd ~/my-project
implement-plan generate "build a user auth system with JWT and refresh tokens"
```

The tool calls Claude (or Codex as fallback) to write the YAML plan, shows it to you, then walks through validation and execution. No YAML knowledge required.

Install the `/implement-plan` Claude Code slash command for even faster access:

```bash
implement-plan install-skill
# Then in any Claude Code session: /implement-plan build user auth with JWT
```

The skill generates the plan via CLI (provider-agnostic), then reviews it with you in chat before executing.

## Manual Usage

```bash
# From the project you want to build features in:
cd ~/my-project

# Validate a plan before burning quota
implement-plan validate ~/.claude/plans/my-feature.md

# Execute (uses Claude as primary, Codex as automatic fallback)
implement-plan ~/.claude/plans/my-feature.md

# Force a specific provider first (still falls back on rate limit)
implement-plan ~/.claude/plans/my-feature.md --provider=codex

# Save quota (no parallel agents)
implement-plan ~/.claude/plans/my-feature.md --sequential

# Preview prompts without running claude
implement-plan ~/.claude/plans/my-feature.md --dry-run

# Resume after crash or rate limit
implement-plan ~/.claude/plans/my-feature.md --from-phase=3
```

## How It Works

1. **Pre-flight**: checks git is clean, detects installed providers (Claude Code and/or Codex)
2. **Provider selection**: Claude is tried first each phase; if rate-limited, Codex takes over automatically
3. **Context injection**: reads `CLAUDE.md` from your project root and injects it into every agent prompt — agents automatically follow your project conventions
4. **Phase execution**: spawns the agent as a subprocess; you see output live in the terminal with a `│` prefix
5. **Completion check**: agent must write `.phase-complete.json` before the orchestrator considers a phase done — no magic string scanning
6. **Independent verify**: orchestrator runs verify commands itself after the agent reports done — two layers of bug protection
7. **Progress**: saved to `.implement-plan-progress.json` after each phase; re-run resumes automatically
8. **Cost reporting**: total USD (where reported) and files written printed at the end

## Plan File Format

Plans are markdown files with an embedded `phases:` YAML block.

```markdown
# My Feature

Brief description.

phases:
  - id: 1
    name: "DB Schema"
    mode: serial
    model: haiku          # haiku | sonnet | opus | auto (default)
    tasks:
      - Add User table to prisma/schema.prisma with fields: id, email, createdAt
      - Run pnpm prisma migrate dev --name add_user
    verify:
      - "pnpm prisma generate"
      - "pnpm build"

  - id: 2
    name: "Service Layer"
    mode: serial
    model: sonnet
    context: |
      Mirror src/modules/orders/services/order.service.ts for the pattern.
    tasks:
      - Implement src/modules/users/user.service.ts with findById, create, update
    verify:
      - "pnpm build"
```

See `examples/plan-template.md` for a fully annotated template with all fields.
See `PLAN_WRITING_GUIDE.md` for rules on writing plans that execute reliably.

## Parallel Phases

Two agents work simultaneously on disjoint file sets:

```yaml
- id: 2
  name: "Engines and Services"
  mode: parallel
  model: sonnet
  teammate_A:
    name: "Pure Engines"
    branch: "impl/engines"
    files:
      - src/modules/quotes/services/discount-engine.ts
      - src/modules/quotes/services/discount-engine.spec.ts
    tasks:
      - Implement discount-engine.ts — applyDiscounts() pure function
      - Write discount-engine.spec.ts — 5 tests
    verify: "pnpm vitest run src/modules/quotes/services/discount-engine.spec.ts"
  teammate_B:
    name: "DB Services"
    branch: "impl/db-services"
    files:
      - src/modules/quotes/services/quote-timeline.service.ts
    tasks:
      - Implement quote-timeline.service.ts — mirror OrderTimelineService
    verify: "pnpm build"
  post_parallel_verify:
    - "pnpm build"
    - "pnpm vitest run src/modules/quotes"
```

**File ownership is absolute** — a file listed in `teammate_A.files` must never be touched by teammate_B. Run `implement-plan validate` to catch overlaps before execution.

## Model Selection

| Tier | Claude Code | OpenAI Codex | Use for |
|------|-------------|--------------|---------|
| `haiku` | `haiku` | `gpt-5.4-mini` | Scaffolding, migrations, constants, file creation |
| `sonnet` | `sonnet` | `gpt-5.4` | Service logic, tests, algorithms |
| `opus` | `opus` | `gpt-5.5` | Complex design decisions (explicit only) |
| `auto` | orchestrator picks haiku or sonnet | same tier selection | — |

On a €20/month plan, `auto` never selects opus. Use `--sequential` to avoid parallel quota burn.

## Provider Configuration

By default, Claude Code is the primary provider and Codex is the automatic fallback (used when Claude is rate-limited).

**Force a specific provider** for a run:
```bash
implement-plan my-plan.md --provider=codex    # Codex first, Claude fallback
implement-plan my-plan.md --provider=claude   # Claude only (no fallback if not found)
```

**Per-phase provider hints** in the plan YAML:
```yaml
- id: 2
  name: "Complex Refactor"
  provider: claude   # prefer Claude for this phase; falls back to Codex if rate-limited
  model: sonnet
  tasks: [...]
```

**Override model names** without recompiling — create `~/.implement-plan.json`:
```json
{
  "claude": { "haiku": "haiku", "sonnet": "sonnet", "opus": "opus" },
  "codex": { "haiku": "gpt-5.4-mini", "sonnet": "gpt-5.4", "opus": "gpt-5.5" },
  "cooldownMinutes": 60
}
```
When OpenAI or Anthropic releases new model versions, update this file — no reinstall needed.

## Rate Limit Handling

Failover is **phase-scoped, not session-sticky**:
- Each new phase tries Claude first (rate-limit flags are cleared per phase)
- If Claude is rate-limited mid-phase, Codex takes over for that phase's remaining attempts
- The *next* phase tries Claude first again

When **both providers are simultaneously rate-limited**, the orchestrator pauses and polls every 5 minutes:
```
⏳ Both providers rate-limited. Resuming at 14:30 (~12 min)...✓
```
Press Ctrl+C to abort the wait — worktrees are cleaned up safely via AbortController.

## When a Phase Fails

The orchestrator saves progress and prints a resume command:

```
❌ Phase 3 failed after 3 attempt(s): verify command failed
Resume with: implement-plan ~/.claude/plans/my-feature.md --from-phase=3
```

Wait for rate limits to clear, then resume. Completed phases are not re-run.

## Project Context

If your project has a `CLAUDE.md` or `.claude/CLAUDE.md`, it's automatically injected into every agent prompt. Agents follow your project's conventions, naming rules, and forbidden patterns without being told explicitly.

## Maintenance — Keeping It Current

This tool wraps the Claude Code CLI directly. Both the CLI and npm packages change. After any update, verify the tool still works.

### Check for outdated packages

```bash
cd ~/Documents/Workspace/implement-plan
npm outdated
```

Update minor/patch versions:
```bash
npm update && npm run build
```

Update across major version boundaries (check release notes first):
```bash
npm install typescript@latest @types/node@latest tsx@latest js-yaml@latest
npm run build   # fix any breaking changes before committing
```

### Check for Claude CLI changes

After running `claude update` or reinstalling Claude Code:

```bash
claude --version
claude --help | grep -E "model|permission|budget|bare|turns|output"
```

Flags to verify are still present: `--permission-mode bypassPermissions`, `--bare`, `--max-budget-usd`, `--output-format stream-json`, `--allowedTools`. If any are missing or renamed, update `spawn()` in `src/providers/claude.ts`.

### Check for Codex CLI changes

After running `codex update` or reinstalling:

```bash
codex --version
codex exec --help
```

Flags to verify: `--sandbox danger-full-access`, `--json`, `--ephemeral`, `-C`. If any are missing or renamed, update `spawn()` in `src/providers/codex.ts`.

### Check for new Claude models

```bash
claude --help | grep -i model
```

When a new model tier is available (e.g. `sonnet-next`), update the `modelMap` in `src/providers/claude.ts` and `VALID_MODELS` in `src/plan-validator.ts`. Or update it at runtime in `~/.implement-plan.json`.

See `CLAUDE.md` for the full dependency policy and AI orchestration best practices.

## CLI Reference

```
implement-plan <plan.md> [options]    Execute a plan
implement-plan validate <plan.md>     Check plan structure

Options:
  --sequential              Run parallel phases one at a time (saves quota)
  --dry-run                 Print prompts, don't call claude
  --from-phase=N            Start from phase N
  --dirty-ok                Skip git clean check
  --provider=claude|codex   Force a specific provider first (still falls back on rate limit)
  --restart        Ignore saved progress
```
