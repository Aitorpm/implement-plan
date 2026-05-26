#!/usr/bin/env node
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import { parsePlan } from './plan-parser'
import { runPhase, PhaseResult, activeWorktrees } from './phase-runner'
import { validatePlan } from './plan-validator'

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
}

function parseArgs(args: string[]): ParsedArgs {
  const isValidate = args[0] === 'validate'
  const planArg = isValidate ? args[1] : args[0]
  const rest = isValidate ? args.slice(2) : args.slice(1)

  return {
    subcommand: isValidate ? 'validate' : 'execute',
    planPath: planArg ? path.resolve(planArg) : '',
    sequential: rest.includes('--sequential'),
    dryRun: rest.includes('--dry-run'),
    dirtyOk: rest.includes('--dirty-ok'),
    restart: rest.includes('--restart'),
    fromPhase: parseInt(rest.find(a => a.startsWith('--from-phase='))?.split('=')[1] ?? '1'),
  }
}

function checkClaudeInPath(): void {
  try {
    execSync('which claude', { stdio: 'ignore' })
  } catch {
    throw new Error("'claude' binary not found in PATH. Install Claude Code CLI first.")
  }
}

function checkGitClean(workDir: string, dirtyOk: boolean): void {
  try {
    const status = execSync('git status --porcelain', { cwd: workDir, encoding: 'utf-8' })
    if (status.trim() && !dirtyOk) {
      throw new Error('Working tree has uncommitted changes. Commit or stash first, or use --dirty-ok.')
    }
  } catch (err: any) {
    if (err.message?.includes('uncommitted')) throw err
    // Not a git repo — warn only
    console.warn('  ⚠ Not a git repository — parallel phases will not work')
  }
}

async function runExecute(planPath: string, workDir: string, opts: ParsedArgs): Promise<void> {
  if (!planPath || !fs.existsSync(planPath)) {
    console.error(`Error: plan file not found: ${planPath}`)
    process.exit(1)
  }

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
    checkClaudeInPath()
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
  const flags = [opts.sequential && 'sequential', opts.dryRun && 'dry-run'].filter(Boolean)
  console.log(`Running phases: ${phases.map(p => p.id).join(', ')}${flags.length ? ` (${flags.join(', ')})` : ''}\n`)

  const start = Date.now()
  let totalCost = progress.results.reduce((s, r) => s + r.costUsd, 0)

  for (const phase of phases) {
    const result = await runPhase(phase, workDir, { sequential: opts.sequential, dryRun: opts.dryRun })
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
  --sequential     Run parallel phases serially (saves quota)
  --dry-run        Print prompts without calling claude
  --from-phase=N   Start from phase N (resume after crash)
  --dirty-ok       Skip git clean check
  --restart        Ignore existing progress file`

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE)
    process.exit(0)
  }

  const opts = parseArgs(args)
  const workDir = process.cwd()

  // Register SIGINT cleanup for parallel worktrees
  process.on('SIGINT', () => {
    if (activeWorktrees.size > 0) {
      console.log('\n⚠ Interrupted — cleaning up worktrees...')
      for (const wt of activeWorktrees) {
        try { execSync(`git worktree remove "${wt}" --force`, { cwd: workDir }) } catch {}
      }
    }
    process.exit(130)
  })

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
