# Plan Writing Guide

Rules for writing plans that `implement-plan` executes reliably.
Read this before writing a plan. Run `implement-plan validate` after.

---

## Phase Scoping

**One phase = one coherent, independently verifiable unit of work.**

Split into two phases when:
- Phase B depends on Phase A's output (schema must exist before service is written)
- You have more than 8 tasks (agents risk running out of turns)
- One part is mechanical (haiku) and another requires logic (sonnet)

Keep in one phase when:
- All tasks share the same verify command
- Tasks are interdependent and can't be checked independently

---

## Writing Tasks

**Be imperative, specific, and include exact identifiers.**

| Bad | Good |
|-----|------|
| "Add the status enum" | "Add `QuoteStatus` enum (`Draft\|Sent\|Accepted\|Rejected`) to `src/common/constants.ts`" |
| "Create the service" | "Create `src/modules/quotes/services/quote.service.ts` implementing `QuoteService` with `findByOrg(orgId)`, `create(data)`, `update(id, patch)`, `softDelete(id)`" |
| "Write tests" | "Write `discount-engine.spec.ts` with 5 tests: threshold application, highest-threshold-wins, stacking, margin floor skip, no-match returns 0%" |

Each task should be doable in **3-5 tool calls** (read a file, write a file, run a command). If a task would require more, split it.

---

## Writing Verify Commands

**Verify commands are the single source of truth for "done".**

Rules:
- Must be a shell command, not prose
- Must exit 0 when work is correct, non-zero when it isn't
- Must be deterministic (same result every time on correct code)
- Must fail clearly when work wasn't done (don't use `echo` or `true`)

```yaml
# BAD
verify:
  - "check that the build works"
  - "echo done"

# GOOD
verify:
  - "pnpm build"
  - "pnpm vitest run src/modules/quotes/services/discount-engine.spec.ts"
  - "test -f src/generated/prisma/schema.ts"
```

For parallel `post_parallel_verify`, verify the *combined* result (e.g., `pnpm build` after both teammates finish), not individual pieces.

---

## Writing Context

**Context should tell agents WHERE to look, not WHAT files contain.**

Agents can read files directly. Describing file contents is wasteful and goes stale.

```yaml
# BAD
context: |
  The QuoteService has findByOrg, create, update, and softDelete methods.
  It follows the repository pattern with PrismaService injected.

# GOOD
context: |
  Mirror src/modules/orders/services/order.service.ts exactly.
  Follow the existing pattern in that file for repository injection and method signatures.
```

Include in context:
- Exact file paths of patterns to mirror
- Specific constraint ("pure functions only — no DB calls")
- Non-obvious conventions ("all spec files use Vitest globals, no imports needed")
- Tech stack version ("NestJS 11 + Prisma 7")

---

## Parallel Phase Rules

**File ownership is absolute.**

1. Every file a teammate might touch must be listed in `files:`
2. No file may appear in both `teammate_A.files` and `teammate_B.files`
3. Barrel exports (`index.ts`) must be assigned to one teammate — or excluded from parallel and handled in a serial phase
4. If both teammates need to read a shared file (like constants.ts), that's fine — just don't write to it from both

**Balance teammate workloads.** Unequal phases waste time — if teammate_A has 8 tasks and teammate_B has 2, the parallel speedup is minimal and quota is wasted.

---

## Model Selection

| Use haiku | Use sonnet | Omit (auto) |
|-----------|------------|-------------|
| File creation, scaffolding | Service logic, state machines | Let the orchestrator decide |
| Schema changes, migrations | Tests with edge cases | |
| Adding constants, types | Algorithms, calculations | |
| Renaming, moving files | Complex refactors | |

Never set `model: opus` unless you have a specific reason — it burns quota ~15× faster than haiku.

---

## Task Count

- **≤ 5 tasks**: comfortable for any model
- **6–8 tasks**: fine, watch the verify complexity
- **> 8 tasks**: warning — consider splitting the phase. Agents can run out of turns.

The turn limit is 40 per agent. Each tool call is one turn. A task that reads 2 files and writes 1 uses 3 turns. 8 tasks × 3 turns = 24 turns. Add compile + test + retry = 30+. That's tight.

---

## Using `project_context_files`

List files the agent should read *before starting*. The orchestrator injects their current content (truncated to 100 lines) into the prompt.

Use when:
- The agent needs to extend an existing file with a known pattern
- There's an interface the agent must implement exactly
- The file contains constants or types referenced in the tasks

Do NOT use for every file in the project — only files directly relevant to the phase.

---

## Checklist Before Running

1. `implement-plan validate my-plan.md` passes with 0 errors
2. Each phase has a real verify command (not echo/true)
3. Parallel teammate file lists have no overlap
4. Each task references specific file paths and identifiers
5. Context cites file paths, not prose descriptions
6. No phase has more than 8 tasks
7. Git working tree is clean in the target project
