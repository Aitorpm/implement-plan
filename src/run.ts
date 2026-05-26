#!/usr/bin/env node
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execSync } from 'child_process'
import { parsePlan } from './plan-parser'
import { runPhase, PhaseResult, activeWorktrees } from './phase-runner'
import { validatePlan } from './plan-validator'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { ProviderRegistry } from './providers/registry'
import { ModelTier } from './providers/types'

interface ModelConfig {
  claude?: Partial<Record<ModelTier, string>>
  codex?: Partial<Record<ModelTier, string>>
  cooldownMinutes?: number
}

interface Progress {
  planPath: string
  completedPhases: number[]
  results: PhaseResult[]
}

interface ParsedArgs {
  subcommand: 'execute' | 'validate'
  planPath: string
  sequential: boolean
  dryRun: boolean
  dirtyOk: boolean
  restart: boolean
  fromPhase: number
  provider?: string
}

function parseArgs(args: string[]): ParsedArgs {
  const isValidate = args[0] === 'validate'
  const planArg = isValidate ? args[1] : args[0]
  const rest = isValidate ? args.slice(2) : args.slice(1)

  const providerArg = rest.find(a => a.startsWith('--provider='))?.split('=')[1]

  return {
    subcommand: isValidate ? 'validate' : 'execute',
    planPath: planArg ? path.resolve(planArg) : '',
    sequential: rest.includes('--sequential'),
    dryRun: rest.includes('--dry-run'),
    dirtyOk: rest.includes('--dirty-ok'),
    restart: rest.includes('--restart'),
    fromPhase: parseInt(rest.find(a => a.startsWith('--from-phase='))?.split('=')[1] ?? '1'),
    provider: providerArg,
  }
}

function loadUserConfig(workDir: string): ModelConfig {
  const candidates = [
    path.join(workDir, '.implement-plan.json'),
    path.join(os.homedir(), '.implement-plan.json'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'))
      } catch {
        console.warn(`  ⚠ Could not parse config at ${p}`)
      }
    }
  }
  return {}
}

function setupProviders(config: ModelConfig, forced?: string): ProviderRegistry {
  const cooldownMs = (config.cooldownMinutes ?? 60) * 60 * 1000
  const allProviders = [
    new ClaudeProvider(config.claude),
    new CodexProvider(config.codex),
  ]

  let ordered = allProviders.filter(p => p.isInstalled())

  if (ordered.length === 0) {
    throw new Error('No providers found. Install claude (Claude Code CLI) or codex (OpenAI Codex CLI).')
  }

  if (forced) {
    const match = ordered.find(p => p.name === forced)
    if (!match) {
      throw new Error(`Provider '${forced}' not found in PATH. Install it first.`)
    }
    ordered = [match, ...ordered.filter(p => p.name !== forced)]
  }

  return new ProviderRegistry(ordered, cooldownMs)
}

function checkGitClean(workDir: string, dirtyOk: boolean): void {
  try {
    const status = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf-8' })
    if (status.trim() && !dirtyOk) {
      throw new Error('Working tree has uncommitted changes. Commit or stash first, or use --dirty-ok.')
    }
  } catch (err: any) {
    if (err.message?.includes('uncommitted')) throw err
    console.warn('  ⚠ Not a git repository — parallel phases will not work')
  }
}

async function runExecute(planPath: string, workDir: string, opts: ParsedArgs): Promise<void> {
  if (!planPath || !fs.existsSync(planPath)) {
    console.error(`Error: plan file not found: ${planPath}`)
    process.exit(1)
  }

  const config = loadUserConfig(workDir)
  const registry = setupProviders(config, opts.provider)

  const providerLine = registry.providers.map((p, i) =>
    i === 0 ? `${p.name} (primary)` : `${p.name} (fallback)`
  ).join(' → ')

  const progressPath = path.join(workDir, '.implement-plan-progress.json')

  let progress: Progress = { planPath, completedPhases: [], results: [] }
  if (fs.existsSync(progressPath) && !opts.restart) {
    try {
      progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'))
      if (progress.completedPhases.length > 0) {
        console.log(`↩ Resuming — phases already done: ${progress.completedPhases.join(', ')}`)
      }
    } catch {
      // corrupted progress file — start fresh
    }
  }

  if (!opts.dryRun) {
    checkGitClean(workDir, opts.dirtyOk)
  }

  const allPhases = parsePlan(planPath)
  const phases = allPhases.filter(p =>
    p.id >= opts.fromPhase && !progress.completedPhases.includes(p.id)
  )

  if (phases.length === 0) {
    console.log('No phases to run.')
    return
  }

  console.log(`📋 ${planPath}`)
  console.log(`📁 ${workDir}`)
  console.log(`Providers: ${providerLine}`)
  const flags = [opts.sequential && 'sequential', opts.dryRun && 'dry-run'].filter(Boolean)
  console.log(`Running phases: ${phases.map(p => p.id).join(', ')}${flags.length ? ` (${flags.join(', ')})` : ''}\n`)

  const abortController = new AbortController()

  process.on('SIGINT', () => {
    abortController.abort()
    if (activeWorktrees.size > 0) {
      console.log('\n⚠ Interrupted — cleaning up worktrees...')
      for (const wt of activeWorktrees) {
        try { execSync(`git worktree remove "${wt}" --force`, { cwd: workDir }) } catch {}
      }
    }
    process.exit(130)
  })

  const start = Date.now()
  let totalCost = progress.results.reduce((s, r) => s + r.costUsd, 0)

  for (const phase of phases) {
    const result = await runPhase(phase, workDir, registry, abortController.signal, {
      sequential: opts.sequential,
      dryRun: opts.dryRun,
    })
    progress.results.push(result)
    totalCost += result.costUsd

    if (!result.success) {
      console.error(`\n❌ Phase ${phase.id} failed after ${result.attempts} attempt(s): ${result.error}`)
      console.error(`Total cost so far: $${totalCost.toFixed(4)}`)
      if (!opts.dryRun) fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2))
      console.error(`\nResume with: implement-plan ${planPath} --from-phase=${phase.id}`)
      process.exit(1)
    }

    progress.completedPhases.push(phase.id)
    if (!opts.dryRun) fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2))
  }

  const elapsed = Math.round((Date.now() - start) / 1000)
  const allFiles = [...new Set(progress.results.flatMap(r => r.filesWritten))]

  console.log(`\n✅ All phases complete`)
  console.log(`   Time:  ${elapsed}s`)
  console.log(`   Cost:  $${totalCost.toFixed(4)}`)
  console.log(`   Files: ${allFiles.length} written`)

  if (!opts.dryRun && fs.existsSync(progressPath)) fs.unlinkSync(progressPath)
}

const USAGE = `Usage:
  implement-plan <plan.md> [options]        Execute a plan
  implement-plan validate <plan.md>         Validate plan structure

Options:
  --sequential          Run parallel phases serially (saves quota)
  --dry-run             Print prompts without calling claude
  --from-phase=N        Start from phase N (resume after crash)
  --dirty-ok            Skip git clean check
  --restart             Ignore existing progress file
  --provider=claude|codex  Force a specific provider first (still falls back on rate limit)`

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE)
    process.exit(0)
  }

  const opts = parseArgs(args)
  const workDir = process.cwd()

  if (opts.subcommand === 'validate') {
    const { ok } = validatePlan(opts.planPath, workDir)
    process.exit(ok ? 0 : 1)
  } else {
    await runExecute(opts.planPath, workDir, opts)
  }
}

main().catch(err => {
  console.error(err.message ?? err)
  process.exit(1)
})
