# implement-plan

Autonomous plan orchestrator for Claude Code. Reads a YAML plan embedded in a markdown file and drives Claude Code headlessly through each phase, with self-verification and cost tracking.

## Install

```bash
cd ~/Documents/Workspace/implement-plan
npm install && npm run build && npm link
```

`implement-plan` is now available globally.

## Usage

```bash
# From the project you want to build features in:
cd ~/my-project

# Validate a plan before burning quota
implement-plan validate ~/.claude/plans/my-feature.md

# Execute
implement-plan ~/.claude/plans/my-feature.md

# Save quota (no parallel agents)
implement-plan ~/.claude/plans/my-feature.md --sequential

# Preview prompts without running claude
implement-plan ~/.claude/plans/my-feature.md --dry-run

# Resume after crash or rate limit
implement-plan ~/.claude/plans/my-feature.md --from-phase=3
```

## How It Works

1. **Pre-flight**: checks git is clean, `claude` is in PATH
2. **Context injection**: reads `CLAUDE.md` from your project root and injects it into every agent prompt — agents automatically follow your project conventions
3. **Phase execution**: spawns `claude` as a subprocess; you see agent output live in the terminal
4. **Completion check**: agent must write `.phase-complete.json` before the orchestrator considers a phase done — no magic string scanning
5. **Independent verify**: orchestrator runs verify commands itself after the agent reports done — two layers of bug protection
6. **Progress**: saved to `.implement-plan-progress.json` after each phase; re-run resumes automatically
7. **Cost reporting**: total USD and files written printed at the end

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

| Model | Use for | Cost |
|-------|---------|------|
| `haiku` | Scaffolding, migrations, constants, file creation | ~$0.001/phase |
| `sonnet` | Service logic, tests, algorithms | ~$0.01/phase |
| `opus` | Complex design decisions (explicit only) | ~$0.05/phase |
| `auto` | Omit the field — orchestrator picks haiku or sonnet | — |

On a €20/month plan, `auto` never selects opus. Use `--sequential` to avoid parallel quota burn.

## When a Phase Fails

The orchestrator saves progress and prints a resume command:

```
❌ Phase 3 failed after 3 attempt(s): verify command failed
Resume with: implement-plan ~/.claude/plans/my-feature.md --from-phase=3
```

Wait for rate limits to clear, then resume. Completed phases are not re-run.

## Project Context

If your project has a `CLAUDE.md` or `.claude/CLAUDE.md`, it's automatically injected into every agent prompt. Agents follow your project's conventions, naming rules, and forbidden patterns without being told explicitly.

## CLI Reference

```
implement-plan <plan.md> [options]    Execute a plan
implement-plan validate <plan.md>     Check plan structure

Options:
  --sequential     Run parallel phases one at a time (saves quota)
  --dry-run        Print prompts, don't call claude
  --from-phase=N   Start from phase N
  --dirty-ok       Skip git clean check
  --restart        Ignore saved progress
```
