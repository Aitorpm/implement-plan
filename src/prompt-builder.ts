import { SerialPhase, ParallelTeammate } from './plan-parser'

const SPEC_ADHERENCE_RULE = `
CRITICAL: Follow the Plan Specification Exactly
This rule governs NEW artifacts you create in this phase (new fields, new constants, new enum values, new interfaces).
It does NOT override the "ACTUAL OUTPUT FROM PRIOR PHASES" section — when referencing code that a prior phase already built, use its actual interfaces, not the plan spec.

Do NOT rename, restructure, or "improve" anything new you write:
- Field names, types, enum values, and constant values must be copied verbatim from the plan.
  Example: if the plan says \`threshold Decimal\`, write \`threshold Decimal\` — not \`minAmount\`.
  Example: if the plan says \`DEFAULT_EXPIRY_DAYS: 14\`, use 14 — not 15 or any other value.
- Never add fields or properties not in the plan unless the compiler requires it.
- Never write comments like "Inferred from..." — if the plan specifies it, use it; if not, omit it.`.trim()

const completionRule = (phaseId: number) => `
COMPLETION REQUIREMENTS (mandatory — do not skip):
1. When you believe all tasks are done, run the verify command yourself.
2. If it fails, fix the issues and run again. Repeat until it passes.
3. Only when verify exits 0, write a file named .phase-complete.json containing exactly:
   {"phase": ${phaseId}, "verified": true, "summary": "<one sentence describing what was done>"}
4. Do not write .phase-complete.json until verify passes.
5. Do not ask questions. Make reasonable decisions and document them in a comment.`

const WIRING_PATTERN = /register\s+(in|with|to)\b|\bwire\s+(up|in|into)\b|\binject\s+into\b|export\s+from\b|add\s+.*\bto\s+.*\bmodule\b|add\s+.*\bprovider\b|import\s+.*\bmodule\b/i

function extractWiringTasks(tasks: string[]): string[] {
  return tasks.filter(t => WIRING_PATTERN.test(t))
}

export function buildSerialPrompt(
  phase: SerialPhase,
  projectDocs?: string,
  currentFiles?: string,
  failureContext?: string,
  priorPhaseFiles?: string,
): string {
  const parts: string[] = [
    'You are implementing a software feature. Complete the following tasks autonomously.',
  ]

  if (projectDocs) {
    parts.push(`PROJECT DOCUMENTATION (follow these conventions):\n${projectDocs}`)
  }

  if (priorPhaseFiles) {
    parts.push(
      `ACTUAL OUTPUT FROM PRIOR PHASES (source of truth — use these files as-is, not the plan spec):\n${priorPhaseFiles}`
    )
  }

  if (currentFiles) {
    parts.push(`CURRENT STATE OF FILES YOU WILL MODIFY:\n${currentFiles}`)
  }

  parts.push(SPEC_ADHERENCE_RULE)

  if (phase.context) {
    parts.push(`CONTEXT:\n${phase.context}`)
  }

  const wiringTasks = extractWiringTasks(phase.tasks)
  if (wiringTasks.length > 0) {
    parts.push(
      `INTEGRATION TASKS — these modify existing files to wire in new components. Do NOT skip them:\n${wiringTasks.map(t => `- ${t}`).join('\n')}`
    )
  }

  parts.push(`TASKS:\n${phase.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)

  parts.push(`VERIFY COMMAND (run this yourself when done):\n${phase.verify.join(' && ')}`)

  if (failureContext) {
    parts.push(`PREVIOUS ATTEMPT FAILED — do not repeat the same approach:\n${failureContext}`)
  }

  parts.push(completionRule(phase.id))

  return parts.join('\n\n')
}

export function buildReviewerPrompt(
  phase: SerialPhase,
  reviewFiles: string[],
): string {
  const fileList = reviewFiles.length > 0
    ? reviewFiles.map(f => `- ${f}`).join('\n')
    : '(no specific files listed — use Glob to find relevant files in the working directory)'

  const wiringTasks = extractWiringTasks(phase.tasks)
  const wiringSection = wiringTasks.length > 0
    ? `\nINTEGRATION TASKS TO CHECK (these are the most commonly skipped):\n${wiringTasks.map(t => `- ${t}`).join('\n')}\n`
    : ''

  return `You are a spec-compliance reviewer. A coding agent just implemented the tasks below. Your job: verify the implementation matches the plan exactly.

PLAN TASKS:
${phase.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${wiringSection}
FILES TO REVIEW:
${fileList}

REVIEW INSTRUCTIONS:
1. Read each file listed above (use Glob if you need to find additional relevant files).
2. For each plan task, check whether it was implemented as specified:
   - Field names, types, enum values, constant values — must match the plan verbatim (no renaming)
   - Integration/wiring tasks — confirm the new component is actually registered/imported in the target file
   - Constants with specific values — confirm the exact values are present
3. Be specific about any deviations: name the missing field, wrong value, or missing import — not just "schema may have issues".

When done, write a file named .phase-review.json:
{"passed": true, "issues": []}
-- or --
{"passed": false, "issues": ["DiscountRule missing 'type' field (plan requires String)", "QUOTE_CONFIG missing 'defaultExpiry' constant"]}

RULES:
- Do NOT modify any source files.
- Only write .phase-review.json.
- If you cannot read a file (it doesn't exist), report that as an issue.
- Do not write .phase-review.json until you have read all relevant files.`
}

export function buildTeammatePrompt(
  teammate: ParallelTeammate,
  phaseId: number,
  projectDocs?: string,
  currentFiles?: string,
  failureContext?: string,
  priorPhaseFiles?: string,
): string {
  const parts: string[] = [
    'You are implementing a software feature. You are working in parallel with another agent — stay strictly in your lane.',
  ]

  if (projectDocs) {
    parts.push(`PROJECT DOCUMENTATION (follow these conventions):\n${projectDocs}`)
  }

  if (priorPhaseFiles) {
    parts.push(
      `ACTUAL OUTPUT FROM PRIOR PHASES (source of truth — use these files as-is, not the plan spec):\n${priorPhaseFiles}`
    )
  }

  if (currentFiles) {
    parts.push(`CURRENT STATE OF FILES YOU WILL MODIFY:\n${currentFiles}`)
  }

  parts.push(SPEC_ADHERENCE_RULE)

  if (teammate.context) {
    parts.push(`CONTEXT:\n${teammate.context}`)
  }

  parts.push(
    `FILES YOU OWN — only modify files in this list:\n${teammate.files.map(f => `- ${f}`).join('\n')}\n\nDO NOT create, edit, or delete any other files.`
  )

  const wiringTasks = extractWiringTasks(teammate.tasks)
  if (wiringTasks.length > 0) {
    parts.push(
      `INTEGRATION TASKS — these modify existing files to wire in new components. Do NOT skip them:\n${wiringTasks.map(t => `- ${t}`).join('\n')}`
    )
  }

  parts.push(`TASKS:\n${teammate.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)

  parts.push(`VERIFY COMMAND (run this yourself when done):\n${teammate.verify}`)

  if (failureContext) {
    parts.push(`PREVIOUS ATTEMPT FAILED — do not repeat the same approach:\n${failureContext}`)
  }

  parts.push(completionRule(phaseId))

  return parts.join('\n\n')
}
