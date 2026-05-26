# implement-plan

Autonomous plan orchestrator for Claude Code and OpenAI Codex. Describe a feature in plain English — the tool generates an implementation plan, routes each phase to the best AI provider, and drives agents through the work with self-verification and automatic rate-limit failover.

---

## How It Works

```
  implement-plan generate "build user auth with JWT"
          │
          ▼
  ┌────────────────────────┐
  │  AI writes plan YAML   │  claude or codex (haiku, cheap)
  └───────────┬────────────┘
              │  review: [Y]es / [e]dit / [s]ave / [a]bort
              ▼
  ┌────────────────────────┐
  │   validate structure   │  file overlaps, missing verify cmds, bad models
  └───────────┬────────────┘
              │
◄─────────────┴─────────────────────────────────────────────────────────┐
│                          phase loop                                    │
│               progress saved after each phase — resumable             │
│                                                                        │
│   SERIAL PHASE                      PARALLEL PHASE                    │
│   ─────────────────────────         ──────────────────────────────    │
│                                                                        │
│   one agent spawned                 two agents spawned at once        │
│          │                          each in its own git worktree      │
│          │                                                             │
│   ┌──────▼──────────────┐           ┌────────────┐  ┌────────────┐   │
│   │  LAYER 1 — agent    │           │  agent A   │  │  agent B   │   │
│   │                     │           │            │  │            │   │
│   │  run tasks          │           │  run tasks │  │  run tasks │   │
│   │  run verify         │           │  run verify│  │  run verify│   │
│   │  fix issues    ◄─┐  │           │  fix  ◄─┐  │  │  fix  ◄─┐  │   │
│   │  run verify    ──┘  │           │  verify ─┘  │  │  verify ─┘  │   │
│   │  (loops until pass) │           └─────┬──────┘  └──────┬─────┘   │
│   │         │           │                 └────────┬────────┘         │
│   │  write .phase-      │                          │                  │
│   │  complete.json      │                    merge files              │
│   └──────┬──────────────┘                    git commit               │
│          │                                   run post_verify          │
│   ┌──────▼──────────────┐                          │                  │
│   │  LAYER 2 — orchest. │◄─────────────────────────┘                  │
│   │                     │                                              │
│   │  re-runs verify     │  independent double-check                   │
│   │  cmds itself        │                                              │
│   └──────┬──────────────┘                                             │
│          │                                                             │
│        pass? ──── yes ──────────────────────────────► next phase ───►─┤
│          │                                                             │
│          no                                                            │
│          │                                                             │
│   inject full error output into next prompt                           │
│   retry (up to 3 attempts total) ──────────────────────────────────►──┘
│          │
│          still failing after 3 attempts?
│          │
│          save progress  →  exit with resume command
│          implement-plan plan.md --from-phase=N
│
│   provider failover (each attempt, transparent):
│   preferred rate-limited? → other provider takes over
│   next phase always tries preferred first again
│
└────────────────────────────────────────────────────────────────────────
              │  all phases done
              ▼
  ┌────────────────────────┐
  │   total cost / files   │
  │   written / time       │
  └────────────────────────┘
```

---

## Step 1 — Install

```bash
cd ~/Documents/Workspace/implement-plan
npm install && npm run build && npm link
```

`implement-plan` is now available globally. Requires at least one of:
- [Claude Code CLI](https://claude.ai/code) — `claude` in PATH
- [OpenAI Codex CLI](https://github.com/openai/codex) — `codex` in PATH

---

## Step 2 — Go to your project

```bash
cd ~/my-project
```

The tool runs agents in the context of the current directory, reads your `CLAUDE.md` for project conventions, and verifies changes with your project's actual build/test commands.

---

## Step 3 — Generate and run a plan

```bash
implement-plan generate "build a user auth system with JWT and refresh tokens"
```

The tool will:
1. Call Claude (or Codex as fallback) to write a structured YAML implementation plan
2. Show you the plan and ask: `[Y]es execute / [e]dit / [s]ave only / [a]bort`
3. Validate the plan structure
4. Execute each phase — agents write code, self-verify, and the orchestrator double-checks

That's it. Each phase runs autonomously and you see live output in the terminal.

---

## Step 4 (optional) — Install the Claude Code slash command

```bash
implement-plan install-skill
```

Then from any Claude Code session in your project:

```
/implement-plan build a user auth system with JWT and refresh tokens
```

Claude generates the plan via CLI, reviews it with you in chat, then executes it. The generation and execution always go through the CLI — not the chat session — so provider failover works even if Claude is rate-limited mid-review.

---

## How It Chooses Providers

The tool automatically routes each phase to the best provider based on task type:

| Task signals | Provider |
|---|---|
| scaffold / migrate / git / bash / generate / create file | **Codex** (82.7% Terminal-Bench) |
| implement / refactor / algorithm / service / edge case | **Claude** (64.3% SWE-bench Pro) |
| test suites in verify (vitest, jest, pytest) | **Claude** |
| No strong signal | Registry order (Claude first) |

If the preferred provider is rate-limited, the other takes over automatically. The next phase always tries from the top again.

You can override per-run with `--provider=claude|codex`, or per-phase in the plan YAML with `provider: claude`.

---

## Resuming After a Failure

If a phase fails or you hit a rate limit mid-execution:

```
❌ Phase 3 failed after 3 attempt(s): verify command failed
Resume with: implement-plan ~/.claude/plans/my-feature.md --from-phase=3
```

Run the resume command. Completed phases are never re-run.

When both providers are simultaneously rate-limited, the orchestrator waits automatically:
```
⏳ Both providers rate-limited. Resuming at 14:30 (~12 min)...✓
```
Press Ctrl+C to abort. Worktrees are cleaned up safely.

---

## Writing Plans by Hand (Advanced)

Plans are markdown files with an embedded `phases:` YAML block:

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
    tasks:
      - Implement src/modules/users/user.service.ts with findById, create, update
    verify:
      - "pnpm build"
```

See `examples/plan-template.md` for a fully annotated template.
See `PLAN_WRITING_GUIDE.md` for rules on writing plans that execute reliably.

Validate before running:
```bash
implement-plan validate ~/.claude/plans/my-feature.md
```

---

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

File ownership is absolute — a file in `teammate_A.files` must never appear in `teammate_B.files`. Run `implement-plan validate` to catch overlaps.

---

## Model Selection

| Tier | Claude Code | OpenAI Codex | Use for |
|------|-------------|--------------|---------|
| `haiku` | `haiku` | `gpt-5.4-mini` | Scaffolding, migrations, constants, file creation |
| `sonnet` | `sonnet` | `gpt-5.4` | Service logic, tests, algorithms |
| `opus` | `opus` | `gpt-5.5` | Complex design decisions (explicit only) |
| `auto` | orchestrator picks | same tier selection | Let the orchestrator decide |

On a €20/month plan, `auto` never selects opus. Use `--sequential` to avoid parallel quota burn.

---

## Provider Configuration

Override model names without reinstalling — create `~/.implement-plan.json`:

```json
{
  "claude": { "haiku": "haiku", "sonnet": "sonnet", "opus": "opus" },
  "codex": { "haiku": "gpt-5.4-mini", "sonnet": "gpt-5.4", "opus": "gpt-5.5" },
  "cooldownMinutes": 60
}
```

When new model versions are released, update this file — no recompile needed.

---

## CLI Reference

```
implement-plan generate <description>         Generate a plan interactively
implement-plan <plan.md> [options]            Execute an existing plan
implement-plan validate <plan.md>             Validate plan structure
implement-plan install-skill                  Install the /implement-plan Claude Code skill

Generate options:
  --save-only                   Generate and save without the interactive prompt
  --dry-run                     Show what would happen without calling the AI
  --provider=claude|codex       Force a specific provider for generation

Execute options:
  --sequential                  Run parallel phases one at a time (saves quota)
  --dry-run                     Print prompts without calling the AI
  --from-phase=N                Resume from phase N after a failure
  --dirty-ok                    Skip git clean check
  --restart                     Ignore existing progress file
  --provider=claude|codex       Force a specific provider first (still falls back)
```

---

## Maintenance

After any `claude update` or `codex update`, verify the CLI flags still match:

```bash
# Claude
claude --help | grep -E "model|permission|budget|bare|output"
# Flags used: --permission-mode bypassPermissions, --bare, --max-budget-usd, --output-format stream-json, --allowedTools

# Codex
codex exec --help
# Flags used: --sandbox danger-full-access, --json, --ephemeral, -C, -m
```

If any flag is renamed, update `spawn()` in `src/providers/claude.ts` or `src/providers/codex.ts`.

Check for outdated npm packages:
```bash
cd ~/Documents/Workspace/implement-plan
npm outdated
npm update && npm run build
```

See `CLAUDE.md` for the full dependency policy and AI orchestration best practices.
