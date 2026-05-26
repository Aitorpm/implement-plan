import { spawn, execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Phase, SerialPhase, ParallelPhase } from './plan-parser'
import { StreamResult, parseStreamWithTee } from './stream-parser'
import { buildSerialPrompt, buildTeammatePrompt } from './prompt-builder'
import { loadProjectDocs, loadPhaseFiles } from './context-loader'
import { selectModel } from './model-selector'

const MODEL_MAP: Record<string, string> = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-7',
}

const MAX_RETRIES = 2
const MAX_TURNS = 40
const COMPLETION_FILE = '.phase-complete.json'
const DEFAULT_TOOLS = 'Edit,Write,Bash,Read,Glob'

// Exported so run.ts can register SIGINT cleanup
export const activeWorktrees = new Set<string>()

export interface PhaseResult {
  phaseId: number
  success: boolean
  costUsd: number
  filesWritten: string[]
  attempts: number
  error?: string
}

export async function runPhase(
  phase: Phase,
  workDir: string,
  opts: { sequential?: boolean; dryRun?: boolean }
): Promise<PhaseResult> {
  let modelKey: string

  if (!phase.model || phase.model === 'auto') {
    const { model, score } = selectModel(phase)
    modelKey = model
    console.log(`\n▶ Phase ${phase.id}: ${phase.name} [${phase.mode}] [model: auto → ${model} (score: ${score})]`)
  } else {
    modelKey = phase.model
    console.log(`\n▶ Phase ${phase.id}: ${phase.name} [${phase.mode}] [${phase.model}]`)
  }

  const modelId = MODEL_MAP[modelKey] ?? MODEL_MAP['sonnet']
  const timeoutMs = (phase.timeout_minutes ?? 15) * 60 * 1000
  const allowedTools = phase.allowed_tools?.join(',') || DEFAULT_TOOLS

  if (phase.mode === 'serial') {
    return runSerial(phase as SerialPhase, workDir, modelId, allowedTools, timeoutMs, opts)
  } else {
    return runParallel(phase as ParallelPhase, workDir, modelId, allowedTools, timeoutMs, opts)
  }
}

async function runSerial(
  phase: SerialPhase,
  workDir: string,
  modelId: string,
  allowedTools: string,
  timeoutMs: number,
  opts: { dryRun?: boolean }
): Promise<PhaseResult> {
  const projectDocs = loadProjectDocs(workDir)
  const currentFiles = phase.project_context_files?.length
    ? loadPhaseFiles(workDir, phase.project_context_files)
    : ''

  let totalCost = 0
  const allFilesWritten: string[] = []
  let lastVerifyOutput = ''

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const failureContext = attempt > 1
      ? `Attempt ${attempt - 1} failed.\nVerify output:\n${lastVerifyOutput}\nDo not repeat the same approach.`
      : undefined

    const prompt = buildSerialPrompt(phase, projectDocs, currentFiles, failureContext)

    if (opts.dryRun) {
      console.log(`[DRY RUN] Would call claude --model ${modelId} --allowedTools ${allowedTools}`)
      console.log(`[DRY RUN] Prompt preview:\n${prompt.slice(0, 300)}...\n`)
      return { phaseId: phase.id, success: true, costUsd: 0, filesWritten: [], attempts: 1 }
    }

    const completionPath = path.join(workDir, COMPLETION_FILE)
    if (fs.existsSync(completionPath)) fs.unlinkSync(completionPath)

    const result = await callClaude(prompt, modelId, allowedTools, workDir, timeoutMs, '│ ')
    totalCost += result.totalCostUsd
    for (const f of result.filesWritten) {
      if (!allFilesWritten.includes(f)) allFilesWritten.push(f)
    }

    if (result.subtype === 'timeout') {
      console.log(`  Attempt ${attempt}: timed out after ${timeoutMs / 60000} min`)
      lastVerifyOutput = `Timed out after ${timeoutMs / 60000} minutes`
      if (attempt > MAX_RETRIES) break
      continue
    }

    console.log(`  Attempt ${attempt}: ${result.subtype}, ${result.numTurns} turns, $${result.totalCostUsd.toFixed(4)}`)

    const completion = readCompletion(completionPath, phase.id)
    if (!completion) {
      console.log(`  ✗ Agent did not write ${COMPLETION_FILE}`)
      lastVerifyOutput = 'Agent did not produce a completion file'
      if (attempt > MAX_RETRIES) {
        return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, error: 'No completion file after max retries' }
      }
      continue
    }

    const verify = captureVerify(phase.verify, workDir)
    if (verify.ok) {
      console.log(`  ✅ Phase ${phase.id} verified`)
      return { phaseId: phase.id, success: true, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt }
    }

    lastVerifyOutput = verify.output
    console.log(`  ✗ Verify failed:\n${verify.output.split('\n').map(l => `    ${l}`).join('\n')}`)
    if (attempt > MAX_RETRIES) {
      return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, error: verify.output }
    }
  }

  return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: MAX_RETRIES + 1, error: 'Exhausted retries' }
}

async function runParallel(
  phase: ParallelPhase,
  workDir: string,
  modelId: string,
  allowedTools: string,
  timeoutMs: number,
  opts: { sequential?: boolean; dryRun?: boolean }
): Promise<PhaseResult> {
  // Validate file ownership
  const filesA = new Set(phase.teammate_A.files ?? [])
  const filesB = new Set(phase.teammate_B.files ?? [])
  const overlap = [...filesA].filter(f => filesB.has(f))
  if (overlap.length > 0) {
    throw new Error(`Phase ${phase.id}: file overlap between teammates: ${overlap.join(', ')}`)
  }

  if (opts.sequential) console.log(`  (--sequential: running teammate_A then teammate_B serially)`)

  const branchA = phase.teammate_A.branch ?? `impl/phase-${phase.id}-a`
  const branchB = phase.teammate_B.branch ?? `impl/phase-${phase.id}-b`
  const wtBase = path.join(workDir, '.worktrees')
  const wtDirA = path.join(wtBase, `phase-${phase.id}-a`)
  const wtDirB = path.join(wtBase, `phase-${phase.id}-b`)

  const projectDocs = loadProjectDocs(workDir)

  if (!opts.dryRun) {
    fs.mkdirSync(wtBase, { recursive: true })
    execSync(`git worktree add -b "${branchA}" "${wtDirA}"`, { cwd: workDir, stdio: 'inherit' })
    activeWorktrees.add(wtDirA)
    execSync(`git worktree add -b "${branchB}" "${wtDirB}"`, { cwd: workDir, stdio: 'inherit' })
    activeWorktrees.add(wtDirB)
  }

  try {
    const currentFilesA = loadPhaseFiles(workDir, phase.teammate_A.files)
    const currentFilesB = loadPhaseFiles(workDir, phase.teammate_B.files)
    const promptA = buildTeammatePrompt(phase.teammate_A, phase.id, projectDocs, currentFilesA)
    const promptB = buildTeammatePrompt(phase.teammate_B, phase.id, projectDocs, currentFilesB)

    const completionPathA = path.join(wtDirA, COMPLETION_FILE)
    const completionPathB = path.join(wtDirB, COMPLETION_FILE)

    if (!opts.dryRun) {
      if (fs.existsSync(completionPathA)) fs.unlinkSync(completionPathA)
      if (fs.existsSync(completionPathB)) fs.unlinkSync(completionPathB)
    }

    let resultA: StreamResult, resultB: StreamResult

    if (opts.dryRun) {
      console.log(`[DRY RUN] Would spawn two claude processes in parallel`)
      const stub: StreamResult = { subtype: 'success', totalCostUsd: 0, numTurns: 0, hasCompletionFile: true, filesWritten: [] }
      resultA = resultB = stub
    } else if (opts.sequential) {
      console.log(`  [teammate_A: ${phase.teammate_A.name}]`)
      resultA = await callClaude(promptA, modelId, allowedTools, wtDirA, timeoutMs, '  A │ ')
      console.log(`  [teammate_B: ${phase.teammate_B.name}]`)
      resultB = await callClaude(promptB, modelId, allowedTools, wtDirB, timeoutMs, '  B │ ')
    } else {
      console.log(`  [spawning ${phase.teammate_A.name} and ${phase.teammate_B.name} in parallel]`)
      ;[resultA, resultB] = await Promise.all([
        callClaude(promptA, modelId, allowedTools, wtDirA, timeoutMs, '  A │ '),
        callClaude(promptB, modelId, allowedTools, wtDirB, timeoutMs, '  B │ '),
      ])
    }

    const totalCost = resultA.totalCostUsd + resultB.totalCostUsd

    if (!opts.dryRun) {
      const doneA = readCompletion(completionPathA, phase.id)
      const doneB = readCompletion(completionPathB, phase.id)
      const missing = [!doneA && 'teammate_A', !doneB && 'teammate_B'].filter(Boolean)
      if (missing.length > 0) {
        return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: [], attempts: 1, error: `${missing.join(', ')} did not write ${COMPLETION_FILE}` }
      }

      // Copy files from worktrees to main working dir
      copyFiles(wtDirA, workDir, phase.teammate_A.files)
      copyFiles(wtDirB, workDir, phase.teammate_B.files)

      execSync('git add .', { cwd: workDir, stdio: 'inherit' })
      execSync(`git commit -m "phase ${phase.id}: ${phase.name}"`, { cwd: workDir, stdio: 'inherit' })

      const verify = captureVerify(phase.post_parallel_verify, workDir)
      if (!verify.ok) {
        return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: [], attempts: 1, error: `Post-parallel verify failed:\n${verify.output}` }
      }
    }

    const filesWritten = [...resultA.filesWritten, ...resultB.filesWritten]
    console.log(`  ✅ Phase ${phase.id} merged and verified`)
    return { phaseId: phase.id, success: true, costUsd: totalCost, filesWritten, attempts: 1 }

  } finally {
    if (!opts.dryRun) {
      for (const [wt, branch] of [[wtDirA, branchA], [wtDirB, branchB]] as [string, string][]) {
        try {
          execSync(`git worktree remove "${wt}" --force`, { cwd: workDir })
          activeWorktrees.delete(wt)
        } catch {}
        try {
          execSync(`git branch -D "${branch}"`, { cwd: workDir })
        } catch {}
      }
    }
  }
}

async function callClaude(
  prompt: string,
  model: string,
  allowedTools: string,
  cwd: string,
  timeoutMs: number,
  prefix: string
): Promise<StreamResult> {
  return new Promise((resolve) => {
    let done = false

    const proc = spawn('claude', [
      '-p', prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--max-turns', String(MAX_TURNS),
      '--allowedTools', allowedTools,
      '--dangerously-skip-permissions',
    ], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })

    const timer = setTimeout(() => {
      if (!done) {
        done = true
        proc.kill('SIGTERM')
        resolve({ subtype: 'timeout', totalCostUsd: 0, numTurns: 0, hasCompletionFile: false, filesWritten: [] })
      }
    }, timeoutMs)

    parseStreamWithTee(proc, prefix).then(result => {
      clearTimeout(timer)
      if (!done) {
        done = true
        resolve(result)
      }
    })
  })
}

function readCompletion(filePath: string, phaseId: number): { verified: boolean; summary: string } | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return data.phase === phaseId && data.verified === true ? data : null
  } catch {
    return null
  }
}

function captureVerify(commands: string[], cwd: string): { ok: boolean; output: string } {
  const outputs: string[] = []

  for (const cmd of commands) {
    try {
      const out = execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
      outputs.push(`$ ${cmd}\n${out}`)
    } catch (err: any) {
      const errOut = (err.stdout ?? '') + (err.stderr ?? '')
      outputs.push(`$ ${cmd}\n${errOut}`)
      return { ok: false, output: outputs.join('\n') }
    }
  }

  return { ok: true, output: outputs.join('\n') }
}

function copyFiles(srcDir: string, dstDir: string, files: string[]): void {
  for (const file of files) {
    const src = path.join(srcDir, file)
    const dst = path.join(dstDir, file)
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    }
  }
}
