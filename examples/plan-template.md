# Plan Template — Annotated

Copy this file, replace the placeholders, and remove the comments.
Run `implement-plan validate your-plan.md` before executing.

# [Feature Name]

[Brief description of what this feature does and why. This is markdown — write for humans.]

phases:

  # SERIAL PHASE — use for sequential tasks where each step depends on the previous
  - id: 1
    name: "DB Schema and Constants"   # Short, describes the output, not the effort
    mode: serial
    model: haiku                      # haiku: mechanical tasks. sonnet: logic/tests. omit: auto-detect.
    allowed_tools: [Edit, Write, Read, Bash]  # omit for default (Edit,Write,Bash,Read,Glob)
    timeout_minutes: 20               # optional, default 15

    # context: paste relevant code snippets, types, or file paths — NOT prose descriptions.
    # Agents read files directly; tell them WHERE to look, not WHAT it contains.
    context: |
      Schema is at prisma/schema.prisma. Follow the naming convention of existing models.
      Constants are exported from src/common/constants.ts — add to existing enums, don't create new files.
      Run `pnpm prisma generate` after any schema change.

    tasks:
      # Each task must be doable in 3-5 tool calls.
      # Be imperative and specific — include file paths, function names, exact values.
      # BAD:  "Add the status enum"
      # GOOD: "Add QuoteStatus enum (Draft|Sent|Accepted|Rejected) to src/common/constants.ts"
      - Add QuoteStatus enum (Draft|Sent|Accepted|Rejected) to src/common/constants.ts
      - Add DiscountRule and Quote models to prisma/schema.prisma per the types in section 2 of this plan
      - Run pnpm prisma migrate dev --name add_quotes

    # verify: shell commands that exit 0 on success, non-zero on failure.
    # Must be deterministic — the agent runs these itself before finishing.
    # BAD:  "check that it works"
    # BAD:  "echo done"
    # GOOD: "pnpm build" or "test -f generated/file.ts"
    verify:
      - "pnpm prisma generate"
      - "pnpm build"

    # project_context_files: files the agent should read before starting.
    # Only list files that are directly relevant — injecting irrelevant files wastes turns.
    project_context_files:
      - prisma/schema.prisma
      - src/common/constants.ts

  # PARALLEL PHASE — use when teammate_A and teammate_B own COMPLETELY separate files.
  # File ownership is absolute: if a file appears in teammate_A.files, teammate_B must NEVER touch it.
  # Even barrel exports (index.ts) must be assigned to one teammate only.
  - id: 2
    name: "Pure Engines and DB Services"
    mode: parallel
    model: sonnet                     # logic-heavy: use sonnet
    timeout_minutes: 25

    teammate_A:
      name: "Pure Engines"
      branch: "impl/engines"          # unique branch name per parallel phase

      # files: list EVERY file this teammate will create or modify.
      # If a file is not listed here, the teammate must not touch it.
      # This list is injected into the teammate's prompt as a hard constraint.
      files:
        - src/modules/quotes/services/discount-engine.ts
        - src/modules/quotes/services/discount-engine.spec.ts

      context: |
        Pure functions only — zero DB calls.
        Mirror the pattern from src/modules/orders/services/order-totals.ts.
        All spec files use Vitest globals (no import needed for describe/it/expect).

      tasks:
        - Implement discount-engine.ts — applyDiscounts(items, rules) pure function
        - Write discount-engine.spec.ts — 5 tests covering all branches

      # verify: a single shell command (string, not array) for parallel teammates
      verify: "pnpm vitest run src/modules/quotes/services/discount-engine.spec.ts"

    teammate_B:
      name: "DB Services"
      branch: "impl/db-services"
      files:
        - src/modules/quotes/services/quote-timeline.service.ts
      context: |
        Mirror src/modules/orders/services/order-timeline.service.ts exactly.
        Substitute quoteId for orderId throughout.
      tasks:
        - Implement quote-timeline.service.ts — mirror OrderTimelineService
      verify: "pnpm build"

    # post_parallel_verify: runs after both teammates finish and files are merged.
    # Should verify the combined result, not individual teammate work.
    post_parallel_verify:
      - "pnpm build"
      - "pnpm vitest run src/modules/quotes"
