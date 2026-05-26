import { SerialPhase, ParallelTeammate } from './plan-parser'

const completionRule = (phaseId: number) => `
COMPLETION REQUIREMENTS (mandatory — do not skip):
1. When you believe all tasks are done, run the verify command yourself.
2. If it fails, fix the issues and run again. Repeat until it passes.
3. Only when verify exits 0, write a file named .phase-complete.json containing exactly:
   {"phase": ${phaseId}, "verified": true, "summary": "<one sentence describing what was done>"}
4. Do not write .phase-complete.json until verify passes.
5. Do not ask questions. Make reasonable decisions and document them in a comment.`

export function buildSerialPrompt(
  phase: SerialPhase,
  projectDocs?: string,
  currentFiles?: string,
  failureContext?: string
): string {
  const parts: string[] = [
    'You are implementing a software feature. Complete the following tasks autonomously.',
  ]

  if (projectDocs) {
    parts.push(`PROJECT DOCUMENTATION (follow these conventions):\n${projectDocs}`)
  }

  if (currentFiles) {
    parts.push(`CURRENT STATE OF FILES YOU WILL MODIFY:\n${currentFiles}`)
  }

  if (phase.context) {
    parts.push(`CONTEXT:\n${phase.context}`)
  }

  parts.push(`TASKS:\n${phase.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)

  parts.push(`VERIFY COMMAND (run this yourself when done):\n${phase.verify.join(' && ')}`)

  if (failureContext) {
    parts.push(`PREVIOUS ATTEMPT FAILED — do not repeat the same approach:\n${failureContext}`)
  }

  parts.push(completionRule(phase.id))

  return parts.join('\n\n')
}

export function buildTeammatePrompt(
  teammate: ParallelTeammate,
  phaseId: number,
  projectDocs?: string,
  currentFiles?: string,
  failureContext?: string
): string {
  const parts: string[] = [
    'You are implementing a software feature. You are working in parallel with another agent — stay strictly in your lane.',
  ]

  if (projectDocs) {
    parts.push(`PROJECT DOCUMENTATION (follow these conventions):\n${projectDocs}`)
  }

  if (currentFiles) {
    parts.push(`CURRENT STATE OF FILES YOU WILL MODIFY:\n${currentFiles}`)
  }

  if (teammate.context) {
    parts.push(`CONTEXT:\n${teammate.context}`)
  }

  parts.push(
    `FILES YOU OWN — only modify files in this list:\n${teammate.files.map(f => `- ${f}`).join('\n')}\n\nDO NOT create, edit, or delete any other files.`
  )

  parts.push(`TASKS:\n${teammate.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`)

  parts.push(`VERIFY COMMAND (run this yourself when done):\n${teammate.verify}`)

  if (failureContext) {
    parts.push(`PREVIOUS ATTEMPT FAILED — do not repeat the same approach:\n${failureContext}`)
  }

  parts.push(completionRule(phaseId))

  return parts.join('\n\n')
}
