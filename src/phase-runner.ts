import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Phase, SerialPhase, ParallelPhase } from './plan-parser'
import { ModelTier, ProviderResult } from './providers/types'
import { ProviderRegistry } from './providers/registry'
import { buildSerialPrompt, buildTeammatePrompt } from './prompt-builder'
import { loadProjectDocs, loadPhaseFiles } from './context-loader'
import { selectModel } from './model-selector'

const MAX_RETRIES = 2
const COMPLETION_FILE = '.phase-complete.json'
const DEFAULT_TOOLS = 'Edit,Write,Bash,Read,Glob'
const DEFAULT_BUDGET_USD = 0.50

// Exported so run.ts can register SIGINT cleanup
export const activeWorktrees = new Set<string>()

export interface PhaseResult {
  phaseId: number
  success: boolean
  costUsd: number
  filesWritten: string[]
  attempts: number
  providerUsed?: string
  error?: string
}

export async function runPhase(
  phase: Phase,
  workDir: string,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
  opts: { sequential?: boolean; dryRun?: boolean }
): Promise<PhaseResult> {
  // Phase-scoped: clear rate limits from previous phase so Claude is tried first again
  registry.nextPhase()

  let tier: ModelTier

  if (!phase.model || phase.model === 'auto') {
    const { model, score } = selectModel(phase)
    tier = model
    console.log(`\n▶ Phase ${phase.id}: ${phase.name} [${phase.mode}] [model: auto → ${tier} (score: ${score})]`)
  } else {
    tier = phase.model === 'opus' ? 'opus' : phase.model === 'sonnet' ? 'sonnet' : 'haiku'
    console.log(`\n▶ Phase ${phase.id}: ${phase.name} [${phase.mode}] [${phase.model}]`)
  }

  const timeoutMs = (phase.timeout_minutes ?? 15) * 60 * 1000
  const allowedTools = phase.allowed_tools?.join(',') || DEFAULT_TOOLS
  const preferredProvider = phase.provider

  if (phase.mode === 'serial') {
    return runSerial(phase as SerialPhase, workDir, tier, allowedTools, timeoutMs, registry, abortSignal, opts, preferredProvider)
  } else {
    return runParallel(phase as ParallelPhase, workDir, tier, allowedTools, timeoutMs, registry, abortSignal, opts, preferredProvider)
  }
}

async function callWithFailover(
  prompt: string,
  tier: ModelTier,
  allowedTools: string,
  workDir: string,
  timeoutMs: number,
  prefix: string,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
  preferred?: string,
): Promise<ProviderResult & { providerUsed: string; subtype: string }> {
  if (registry.allRateLimited()) {
    await registry.waitForAvailable(abortSignal)
  }

  if (abortSignal.aborted) {
    return { success: false, rateLimited: false, costUsd: 0, numTurns: 0, hasCompletionFile: false, filesWritten: [], providerUsed: 'none', subtype: 'cancelled' }
  }

  const provider = registry.getAvailable(preferred)
  if (!provider) {
    return { success: false, rateLimited: true, costUsd: 0, numTurns: 0, hasCompletionFile: false, filesWritten: [], providerUsed: 'none', subtype: 'rate_limited', error: 'No provider available' }
  }

  const model = provider.modelMap[tier]
  const budgetUsd = (timeoutMs / 60000 / 15) * DEFAULT_BUDGET_USD

  let timedOut = false
  const proc = provider.spawn(prompt, model, allowedTools, workDir, budgetUsd)

  const timeoutHandle = setTimeout(() => {
    timedOut = true
    proc.kill('SIGTERM')
  }, timeoutMs)

  const result = await provider.parseStream(proc, prefix, workDir)
  clearTimeout(timeoutHandle)

  if (timedOut) {
    return { ...result, success: false, subtype: 'timeout', providerUsed: provider.name }
  }

  if (result.rateLimited) {
    console.log(`  ⚠ ${provider.name} rate-limited — trying next provider for this phase`)
    registry.markRateLimitedForPhase(provider.name)
    return callWithFailover(prompt, tier, allowedTools, workDir, timeoutMs, prefix, registry, abortSignal, preferred)
  }

  const subtype = result.success ? 'success' : (result.error ?? 'error_during_execution')
  return { ...result, subtype, providerUsed: provider.name }
}

async function runSerial(
  phase: SerialPhase,
  workDir: string,
  tier: ModelTier,
  allowedTools: string,
  timeoutMs: number,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
  opts: { dryRun?: boolean },
  preferred?: string,
): Promise<PhaseResult> {
  const projectDocs = loadProjectDocs(workDir)
  const currentFiles = phase.project_context_files?.length
    ? loadPhaseFiles(workDir, phase.project_context_files)
    : ''

  let totalCost = 0
  const allFilesWritten: string[] = []
  let lastVerifyOutput = ''
  let lastProviderUsed: string | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const failureContext = attempt > 1
      ? `Attempt ${attempt - 1} failed.\nVerify output:\n${lastVerifyOutput}\nDo not repeat the same approach.`
      : undefined

    const prompt = buildSerialPrompt(phase, projectDocs, currentFiles, failureContext)

    if (opts.dryRun) {
      const providerName = preferred ?? registry.getAvailable()?.name ?? 'claude'
      const modelName = registry.getAvailable(preferred)?.modelMap[tier] ?? tier
      console.log(`[DRY RUN] Would call ${providerName} model=${modelName} tier=${tier}`)
      console.log(`[DRY RUN] Prompt preview:\n${prompt.slice(0, 300)}...\n`)
      return { phaseId: phase.id, success: true, costUsd: 0, filesWritten: [], attempts: 1, providerUsed: providerName }
    }

    const completionPath = path.join(workDir, COMPLETION_FILE)
    if (fs.existsSync(completionPath)) fs.unlinkSync(completionPath)

    const result = await callWithFailover(prompt, tier, allowedTools, workDir, timeoutMs, '│ ', registry, abortSignal, preferred)
    lastProviderUsed = result.providerUsed
    totalCost += result.costUsd
    for (const f of result.filesWritten) {
      if (!allFilesWritten.includes(f)) allFilesWritten.push(f)
    }

    if (result.subtype === 'timeout') {
      console.log(`  Attempt ${attempt}: timed out after ${timeoutMs / 60000} min`)
      lastVerifyOutput = `Timed out after ${timeoutMs / 60000} minutes`
      if (attempt > MAX_RETRIES) break
      continue
    }

    console.log(`  Attempt ${attempt} [${result.providerUsed}]: ${result.subtype}, ${result.numTurns} turns, $${result.costUsd.toFixed(4)}`)

    const completion = readCompletion(completionPath, phase.id)
    if (!completion) {
      console.log(`  ✗ Agent did not write ${COMPLETION_FILE}`)
      lastVerifyOutput = 'Agent did not produce a completion file'
      if (attempt > MAX_RETRIES) {
        return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviderUsed, error: 'No completion file after max retries' }
      }
      continue
    }

    const verify = captureVerify(phase.verify, workDir)
    if (verify.ok) {
      console.log(`  ✅ Phase ${phase.id} verified [${result.providerUsed}, ${result.costUsd > 0 ? `$${result.costUsd.toFixed(4)}` : 'no cost reported'}]`)
      return { phaseId: phase.id, success: true, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviderUsed }
    }

    lastVerifyOutput = verify.output
    console.log(`  ✗ Verify failed:\n${verify.output.split('\n').map(l => `    ${l}`).join('\n')}`)
    if (attempt > MAX_RETRIES) {
      return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviderUsed, error: verify.output }
    }
  }

  return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: MAX_RETRIES + 1, providerUsed: lastProviderUsed, error: 'Exhausted retries' }
}

async function runParallel(
  phase: ParallelPhase,
  workDir: string,
  tier: ModelTier,
  allowedTools: string,
  timeoutMs: number,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
  opts: { sequential?: boolean; dryRun?: boolean },
  preferred?: string,
): Promise<PhaseResult> {
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

    let resultA: ProviderResult & { providerUsed: string; subtype: string }
    let resultB: ProviderResult & { providerUsed: string; subtype: string }

    if (opts.dryRun) {
      const providerName = preferred ?? registry.getAvailable()?.name ?? 'claude'
      console.log(`[DRY RUN] Would spawn two ${providerName} processes in parallel`)
      const stub = { success: true, rateLimited: false, costUsd: 0, numTurns: 0, hasCompletionFile: true, filesWritten: [], providerUsed: providerName, subtype: 'success' }
      resultA = resultB = stub
    } else if (opts.sequential) {
      console.log(`  [teammate_A: ${phase.teammate_A.name}]`)
      resultA = await callWithFailover(promptA, tier, allowedTools, wtDirA, timeoutMs, '  A │ ', registry, abortSignal, preferred)
      console.log(`  [teammate_B: ${phase.teammate_B.name}]`)
      resultB = await callWithFailover(promptB, tier, allowedTools, wtDirB, timeoutMs, '  B │ ', registry, abortSignal, preferred)
    } else {
      console.log(`  [spawning ${phase.teammate_A.name} and ${phase.teammate_B.name} in parallel]`)
      ;[resultA, resultB] = await Promise.all([
        callWithFailover(promptA, tier, allowedTools, wtDirA, timeoutMs, '  A │ ', registry, abortSignal, preferred),
        callWithFailover(promptB, tier, allowedTools, wtDirB, timeoutMs, '  B │ ', registry, abortSignal, preferred),
      ])
    }

    const totalCost = resultA.costUsd + resultB.costUsd

    if (!opts.dryRun) {
      const doneA = readCompletion(completionPathA, phase.id)
      const doneB = readCompletion(completionPathB, phase.id)
      const missing = [!doneA && 'teammate_A', !doneB && 'teammate_B'].filter(Boolean)
      if (missing.length > 0) {
        return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: [], attempts: 1, error: `${missing.join(', ')} did not write ${COMPLETION_FILE}` }
      }

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
    const providers = [...new Set([resultA.providerUsed, resultB.providerUsed])].join('+')
    console.log(`  ✅ Phase ${phase.id} merged and verified [${providers}]`)
    return { phaseId: phase.id, success: true, costUsd: totalCost, filesWritten, attempts: 1, providerUsed: providers }

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
