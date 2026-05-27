import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Phase, SerialPhase, ParallelPhase } from './plan-parser'
import { ModelTier, ProviderResult } from './providers/types'
import { ProviderRegistry } from './providers/registry'
import { buildSerialPrompt, buildTeammatePrompt, buildReviewerPrompt } from './prompt-builder'
import { loadProjectDocs, loadPhaseFiles } from './context-loader'
import { selectModel } from './model-selector'
import { selectProvider } from './provider-selector'
import { isMissingCommandFailure, preflightVerifyCommands } from './verify-preflight'

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

type AgentResult = ProviderResult & {
  providerUsed: string
  subtype: string
  elapsedMs: number
}

export async function runPhase(
  phase: Phase,
  workDir: string,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
  opts: { sequential?: boolean; dryRun?: boolean; phaseIndex?: number; totalPhases?: number; forcedProvider?: string; priorPhaseFiles?: string }
): Promise<PhaseResult> {
  // Phase-scoped: clear rate limits from previous phase so Claude is tried first again
  registry.nextPhase()

  let tier: ModelTier
  let modelLabel: string

  if (!phase.model || phase.model === 'auto') {
    const { model, score } = selectModel(phase, opts.priorPhaseFiles?.length ?? 0)
    tier = model
    modelLabel = `model: auto → ${tier} (score: ${score})`
  } else {
    tier = phase.model === 'opus' ? 'powerful' : phase.model === 'sonnet' ? 'standard' : 'fast'
    modelLabel = phase.model
  }

  // Provider selection: explicit YAML hint wins; otherwise auto-select by task signals
  let preferredProvider: string | undefined
  let providerLabel: string

  if (opts.forcedProvider) {
    preferredProvider = opts.forcedProvider
    providerLabel = `provider: forced → ${opts.forcedProvider}`
  } else if (phase.provider) {
    preferredProvider = phase.provider
    providerLabel = `provider: explicit → ${phase.provider}`
  } else {
    const { provider, score } = selectProvider(phase, tier)
    preferredProvider = provider ?? undefined
    providerLabel = provider
      ? `provider: auto → ${provider} (score: ${score})`
      : `provider: auto → default`
  }

  const phaseLabel = opts.totalPhases ? `${opts.phaseIndex}/${opts.totalPhases}` : String(phase.id)
  console.log(`\n▶ Phase ${phaseLabel}: ${phase.name} [${phase.mode}] [${modelLabel}] [${providerLabel}]`)

  const timeoutMs = (phase.timeout_minutes ?? 15) * 60 * 1000
  const allowedTools = phase.allowed_tools?.join(',') || DEFAULT_TOOLS

  if (phase.mode === 'serial') {
    return runSerial(phase as SerialPhase, workDir, tier, allowedTools, timeoutMs, registry, abortSignal, { dryRun: opts.dryRun, priorPhaseFiles: opts.priorPhaseFiles }, preferredProvider)
  } else {
    return runParallel(phase as ParallelPhase, workDir, tier, allowedTools, timeoutMs, registry, abortSignal, { sequential: opts.sequential, dryRun: opts.dryRun, priorPhaseFiles: opts.priorPhaseFiles }, preferredProvider)
  }
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

function startHeartbeat(prefix: string, intervalMs = 60_000): () => void {
  const start = Date.now()
  const id = setInterval(() => {
    process.stdout.write(`${prefix}⏱  still running... ${fmt(Date.now() - start)}\n`)
  }, intervalMs)
  return () => clearInterval(id)
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
): Promise<AgentResult> {
  const timedOutProviders = new Set<string>()

  while (true) {
    if (registry.allRateLimited()) {
      // If every exhausted provider timed out (not quota-limited), fail fast instead of waiting
      if (registry.providers.every(p => timedOutProviders.has(p.name))) {
        return { success: false, rateLimited: false, costUsd: 0, numTurns: 0, hasCompletionFile: false, filesWritten: [], providerUsed: 'none', subtype: 'timeout', elapsedMs: 0, error: 'All providers timed out' }
      }
      await registry.waitForAvailable(abortSignal)
    }

    if (abortSignal.aborted) {
      return { success: false, rateLimited: false, costUsd: 0, numTurns: 0, hasCompletionFile: false, filesWritten: [], providerUsed: 'none', subtype: 'cancelled', elapsedMs: 0 }
    }

    const provider = registry.getAvailable(preferred)
    if (!provider) {
      return { success: false, rateLimited: true, costUsd: 0, numTurns: 0, hasCompletionFile: false, filesWritten: [], providerUsed: 'none', subtype: 'rate_limited', elapsedMs: 0, error: 'No provider available' }
    }

    const model = provider.modelMap[tier]
    const budgetUsd = (timeoutMs / 60000 / 15) * DEFAULT_BUDGET_USD

    let timedOut = false
    const proc = provider.spawn(prompt, model, allowedTools, workDir, budgetUsd)
    const agentStart = Date.now()
    const stopHeartbeat = startHeartbeat(prefix)

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, timeoutMs)

    let result: ProviderResult
    try {
      result = await provider.parseStream(proc, prefix, workDir)
    } finally {
      clearTimeout(timeoutHandle)
      stopHeartbeat()
    }
    const elapsedMs = Date.now() - agentStart

    if (timedOut) {
      timedOutProviders.add(provider.name)
      console.log(`  ⚠ ${provider.name} timed out after ${fmt(elapsedMs)} — trying next provider for this phase`)
      registry.markRateLimitedForPhase(provider.name)
      continue
    }

    if (result.rateLimited) {
      console.log(`  ⚠ ${provider.name} rate-limited after ${fmt(elapsedMs)} — trying next provider for this phase`)
      registry.markRateLimitedForPhase(provider.name)
      continue
    }

    const subtype = result.success ? 'success' : (result.error ?? 'error_during_execution')
    return { ...result, subtype, providerUsed: provider.name, elapsedMs }
  }
}

function cleanWorkdir(workDir: string): void {
  try {
    execSync('git reset --hard HEAD', { cwd: workDir, stdio: 'pipe' })
    execSync('git clean -fd', { cwd: workDir, stdio: 'pipe' })
    console.log(`  ↺ Workdir reset to HEAD`)
  } catch {
    // Not a git repo or no commits yet — skip.
  }
}

function getChangedFiles(workDir: string): string[] {
  try {
    const modified = execSync('git diff --name-only HEAD', { cwd: workDir, encoding: 'utf-8' }).trim()
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: workDir, encoding: 'utf-8' }).trim()
    return [...modified.split('\n'), ...untracked.split('\n')].filter(Boolean)
  } catch {
    return []
  }
}

async function reviewPhaseOutput(
  phase: SerialPhase,
  workDir: string,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
): Promise<{ passed: boolean; issues: string[] }> {
  if (abortSignal.aborted) return { passed: true, issues: [] }

  const reviewPath = path.join(workDir, '.phase-review.json')
  if (fs.existsSync(reviewPath)) fs.unlinkSync(reviewPath)

  const changedFiles = getChangedFiles(workDir)
  const reviewFiles = [...new Set([
    ...(phase.project_context_files ?? []),
    ...changedFiles.filter(f => !f.startsWith('.')),
  ])]

  const prompt = buildReviewerPrompt(phase, reviewFiles)
  console.log(`  🔍 Running spec-compliance review...`)

  const result = await callWithFailover(
    prompt,
    'fast',
    'Read,Glob,Write',
    workDir,
    120_000,
    '  R │ ',
    registry,
    abortSignal,
  )

  if (result.subtype === 'cancelled') return { passed: true, issues: [] }

  try {
    if (fs.existsSync(reviewPath)) {
      const data = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'))
      return {
        passed: Boolean(data.passed),
        issues: Array.isArray(data.issues) ? (data.issues as string[]) : [],
      }
    }
  } catch {}

  // Reviewer didn't produce output — don't block progress
  console.log(`  ⚠ Reviewer did not write .phase-review.json — skipping review`)
  return { passed: true, issues: [] }
}

async function runSerial(
  phase: SerialPhase,
  workDir: string,
  tier: ModelTier,
  allowedTools: string,
  timeoutMs: number,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
  opts: { dryRun?: boolean; priorPhaseFiles?: string },
  preferred?: string,
): Promise<PhaseResult> {
  const projectDocs = loadProjectDocs(workDir)
  const currentFiles = phase.project_context_files?.length
    ? loadPhaseFiles(workDir, phase.project_context_files)
    : ''

  const preflight = preflightVerifyCommands(phase.verify)
  if (!preflight.ok) {
    console.log(`  ✗ Verify command unavailable: ${preflight.output}`)
    return { phaseId: phase.id, success: false, costUsd: 0, filesWritten: [], attempts: 0, error: preflight.output }
  }

  let totalCost = 0
  const allFilesWritten: string[] = []
  let lastVerifyOutput = ''
  let lastProviderUsed: string | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (attempt > 1) cleanWorkdir(workDir)

    const failureContext = attempt > 1
      ? `Attempt ${attempt - 1} failed.\nVerify output:\n${lastVerifyOutput}\nDo not repeat the same approach.`
      : undefined

    const prompt = buildSerialPrompt(phase, projectDocs, currentFiles, failureContext, opts.priorPhaseFiles)

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

    console.log(`  Attempt ${attempt} [${result.providerUsed}]: ${result.subtype}, ${result.numTurns} turns, ${fmt(result.elapsedMs)}, $${result.costUsd.toFixed(4)}`)

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
      const review = await reviewPhaseOutput(phase, workDir, registry, abortSignal)
      if (!review.passed) {
        if (attempt <= MAX_RETRIES) {
          lastVerifyOutput = `Build passes but spec review found issues:\n${review.issues.map(i => `- ${i}`).join('\n')}`
          console.log(`  ✗ Spec review found issues (will retry):`)
          for (const issue of review.issues) console.log(`    - ${issue}`)
          continue
        }
        console.log(`  ⚠ Spec review found issues (proceeding — max retries reached):`)
        for (const issue of review.issues) console.log(`    - ${issue}`)
      }
      commitPhaseFiles(workDir, phase.id, phase.name, allFilesWritten)
      const reviewNote = !review.passed ? ' [review warnings]' : ''
      console.log(`  ✅ Phase ${phase.id} verified [${result.providerUsed}, ${result.costUsd > 0 ? `$${result.costUsd.toFixed(4)}` : 'no cost reported'}]${reviewNote}`)
      printFileSummary(allFilesWritten, workDir)
      return { phaseId: phase.id, success: true, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviderUsed }
    }

    lastVerifyOutput = verify.output
    console.log(`  ✗ Verify failed:\n${verify.output.split('\n').map(l => `    ${l}`).join('\n')}`)
    if (isMissingCommandFailure(verify.output)) {
      return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviderUsed, error: verify.output }
    }
    if (attempt > MAX_RETRIES) {
      return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviderUsed, error: verify.output }
    }
  }

  return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: MAX_RETRIES + 1, providerUsed: lastProviderUsed, error: 'Exhausted retries' }
}

function commitPhaseFiles(workDir: string, phaseId: number, phaseName: string, files: string[]): void {
  try {
    // Stage tracked files first (from tool_use events), then fall back to git add -A
    // to catch files created via Bash commands (e.g. prisma migrate, sed, echo).
    const uniqueFiles = [...new Set(files)].filter(file =>
      file !== COMPLETION_FILE &&
      file !== '.implement-plan-progress.json' &&
      !file.startsWith('.worktrees/'),
    )
    if (uniqueFiles.length > 0) {
      execSync(`git add -- ${uniqueFiles.map(shellQuote).join(' ')}`, { cwd: workDir, stdio: 'pipe' })
    }
    execSync('git add -A', { cwd: workDir, stdio: 'pipe' })

    const staged = execSync('git diff --cached --name-only', { cwd: workDir, encoding: 'utf-8' }).trim()
    if (!staged) {
      console.log(`  ⚠ Phase ${phaseId} produced no file changes — check that the implementation wrote output`)
      return
    }
    execSync(`git commit -m ${shellQuote(`phase ${phaseId}: ${phaseName}`)}`, { cwd: workDir, stdio: 'inherit' })
  } catch {
    // Not a git repo, or commit failed — non-fatal.
  }
}

async function runParallel(
  phase: ParallelPhase,
  workDir: string,
  tier: ModelTier,
  allowedTools: string,
  timeoutMs: number,
  registry: ProviderRegistry,
  abortSignal: AbortSignal,
  opts: { sequential?: boolean; dryRun?: boolean; priorPhaseFiles?: string },
  preferred?: string,
): Promise<PhaseResult> {
  const filesA = new Set(phase.teammate_A.files ?? [])
  const filesB = new Set(phase.teammate_B.files ?? [])
  const overlap = [...filesA].filter(f => filesB.has(f))
  if (overlap.length > 0) {
    throw new Error(`Phase ${phase.id}: file overlap between teammates: ${overlap.join(', ')}`)
  }

  if (opts.sequential) console.log(`  (--sequential: running teammate_A then teammate_B serially)`)

  const preflight = preflightVerifyCommands([
    phase.teammate_A.verify,
    phase.teammate_B.verify,
    ...phase.post_parallel_verify,
  ])
  if (!preflight.ok) {
    console.log(`  ✗ Verify command unavailable: ${preflight.output}`)
    return { phaseId: phase.id, success: false, costUsd: 0, filesWritten: [], attempts: 0, error: preflight.output }
  }

  const branchA = phase.teammate_A.branch ?? `impl/phase-${phase.id}-a`
  const branchB = phase.teammate_B.branch ?? `impl/phase-${phase.id}-b`
  const wtBase = path.join(workDir, '.worktrees')
  const wtDirA = path.join(wtBase, `phase-${phase.id}-a`)
  const wtDirB = path.join(wtBase, `phase-${phase.id}-b`)

  const projectDocs = loadProjectDocs(workDir)

  if (opts.dryRun) {
    const providerName = preferred ?? registry.getAvailable()?.name ?? 'claude'
    console.log(`[DRY RUN] Would spawn two ${providerName} processes in parallel`)
    return { phaseId: phase.id, success: true, costUsd: 0, filesWritten: [], attempts: 1, providerUsed: providerName }
  }

  let totalCost = 0
  const allFilesWritten: string[] = []
  let lastVerifyOutputA = ''
  let lastVerifyOutputB = ''
  let lastProviders = ''

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    fs.mkdirSync(wtBase, { recursive: true })
    execSync(`git worktree add -b "${branchA}" "${wtDirA}"`, { cwd: workDir, stdio: 'inherit' })
    activeWorktrees.add(wtDirA)
    execSync(`git worktree add -b "${branchB}" "${wtDirB}"`, { cwd: workDir, stdio: 'inherit' })
    activeWorktrees.add(wtDirB)

    try {
      const failureContextA = attempt > 1 && lastVerifyOutputA
        ? `Attempt ${attempt - 1} failed.\nVerify output:\n${lastVerifyOutputA}\nDo not repeat the same approach.`
        : undefined
      const failureContextB = attempt > 1 && lastVerifyOutputB
        ? `Attempt ${attempt - 1} failed.\nVerify output:\n${lastVerifyOutputB}\nDo not repeat the same approach.`
        : undefined

      const currentFilesA = loadPhaseFiles(workDir, phase.teammate_A.files)
      const currentFilesB = loadPhaseFiles(workDir, phase.teammate_B.files)
      const promptA = buildTeammatePrompt(phase.teammate_A, phase.id, projectDocs, currentFilesA, failureContextA, opts.priorPhaseFiles)
      const promptB = buildTeammatePrompt(phase.teammate_B, phase.id, projectDocs, currentFilesB, failureContextB, opts.priorPhaseFiles)

      const completionPathA = path.join(wtDirA, COMPLETION_FILE)
      const completionPathB = path.join(wtDirB, COMPLETION_FILE)

      let resultA: AgentResult
      let resultB: AgentResult

      if (opts.sequential) {
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

      totalCost += resultA.costUsd + resultB.costUsd
      for (const f of [...resultA.filesWritten, ...resultB.filesWritten]) {
        if (!allFilesWritten.includes(f)) allFilesWritten.push(f)
      }
      lastProviders = [...new Set([resultA.providerUsed, resultB.providerUsed])].join('+')

      console.log(`  Attempt ${attempt} [${lastProviders}]: A=${resultA.subtype} ${fmt(resultA.elapsedMs)}, B=${resultB.subtype} ${fmt(resultB.elapsedMs)}`)

      const doneA = readCompletion(completionPathA, phase.id)
      const doneB = readCompletion(completionPathB, phase.id)

      if (!doneA || !doneB) {
        const missing = [!doneA && `teammate_A (${resultA.subtype})`, !doneB && `teammate_B (${resultB.subtype})`].filter(Boolean)
        const errMsg = `${missing.join(', ')} did not write ${COMPLETION_FILE}`
        console.log(`  ✗ ${errMsg}`)
        lastVerifyOutputA = !doneA ? `Agent did not produce a completion file (${resultA.subtype})` : ''
        lastVerifyOutputB = !doneB ? `Agent did not produce a completion file (${resultB.subtype})` : ''
        if (attempt > MAX_RETRIES) {
          return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviders, error: errMsg }
        }
        continue
      }

      const copiedFiles = [
        ...copyFiles(wtDirA, workDir, phase.teammate_A.files),
        ...copyFiles(wtDirB, workDir, phase.teammate_B.files),
      ]

      if (copiedFiles.length > 0) {
        execSync(`git add -- ${copiedFiles.map(shellQuote).join(' ')}`, { cwd: workDir, stdio: 'pipe' })
      }
      const parallelStaged = execSync('git diff --cached --name-only', { cwd: workDir, encoding: 'utf-8' }).trim()
      if (!parallelStaged) {
        console.log(`  ⚠ Phase ${phase.id} parallel merge: no files staged — check that teammates wrote output`)
      } else {
        execSync(`git commit -m ${shellQuote(`phase ${phase.id}: ${phase.name}`)}`, { cwd: workDir, stdio: 'inherit' })
      }

      const verify = captureVerify(phase.post_parallel_verify, workDir)
      if (verify.ok) {
        console.log(`  ✅ Phase ${phase.id} merged and verified [${lastProviders}]`)
        printFileSummary(allFilesWritten, workDir)
        return { phaseId: phase.id, success: true, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviders }
      }

      // Post-parallel verify failed — both teammates get the same error context for next retry
      lastVerifyOutputA = verify.output
      lastVerifyOutputB = verify.output
      console.log(`  ✗ Post-parallel verify failed:\n${verify.output.split('\n').map(l => `    ${l}`).join('\n')}`)
      if (isMissingCommandFailure(verify.output)) {
        return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviders, error: `Post-parallel verify failed:\n${verify.output}` }
      }
      if (attempt > MAX_RETRIES) {
        return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: attempt, providerUsed: lastProviders, error: `Post-parallel verify failed:\n${verify.output}` }
      }

    } finally {
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

  return { phaseId: phase.id, success: false, costUsd: totalCost, filesWritten: allFilesWritten, attempts: MAX_RETRIES + 1, providerUsed: lastProviders, error: 'Exhausted retries' }
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

function copyFiles(srcDir: string, dstDir: string, files: string[]): string[] {
  const copied: string[] = []
  for (const file of files) {
    const src = path.join(srcDir, file)
    const dst = path.join(dstDir, file)
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
      copied.push(file)
    }
  }
  return copied
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function printFileSummary(filesWritten: string[], workDir: string): void {
  const display = filesWritten.filter(f =>
    !f.endsWith('.phase-complete.json') &&
    !f.endsWith('.phase-review.json') &&
    !f.endsWith('.implement-plan-progress.json'),
  )
  if (display.length === 0) return
  const rel = (f: string) => f.startsWith(workDir + '/') ? f.slice(workDir.length + 1) : f
  console.log(`  Files (${display.length}):`)
  for (const f of display) console.log(`    ${rel(f)}`)
}
