#!/usr/bin/env node
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as readline from 'readline'
import { execSync, spawnSync } from 'child_process'
import { parsePlan } from './plan-parser'
import { runPhase, PhaseResult, activeWorktrees } from './phase-runner'
import { validatePlan } from './plan-validator'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { ProviderRegistry } from './providers/registry'
import { ModelTier } from './providers/types'
import { generatePlan, toSlug } from './plan-generator'

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
  subcommand: 'execute' | 'validate' | 'generate' | 'install-skill'
  planPath: string
  description: string
  sequential: boolean
  dryRun: boolean
  dirtyOk: boolean
  restart: boolean
  fromPhase: number
  provider?: string
  saveOnly: boolean
}

function parseArgs(args: string[]): ParsedArgs {
  const defaults: ParsedArgs = {
    subcommand: 'execute',
    planPath: '',
    description: '',
    sequential: false,
    dryRun: false,
    dirtyOk: false,
    restart: false,
    fromPhase: 1,
    saveOnly: false,
  }

  if (args[0] === 'validate') {
    return { ...defaults, subcommand: 'validate', planPath: args[1] ? path.resolve(args[1]) : '' }
  }

  if (args[0] === 'install-skill') {
    return { ...defaults, subcommand: 'install-skill' }
  }

  if (args[0] === 'generate') {
    const rest = args.slice(1)
    const flags = rest.filter(a => a.startsWith('--'))
    const words = rest.filter(a => !a.startsWith('--'))
    const providerArg = flags.find(a => a.startsWith('--provider='))?.split('=')[1]
    return {
      ...defaults,
      subcommand: 'generate',
      description: words.join(' '),
      dryRun: flags.includes('--dry-run'),
      saveOnly: flags.includes('--save-only'),
      provider: providerArg,
    }
  }

  // Default: execute
  const planArg = args[0]
  const rest = args.slice(1)
  const providerArg = rest.find(a => a.startsWith('--provider='))?.split('=')[1]
  return {
    ...defaults,
    subcommand: 'execute',
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

function prompt(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

async function runGenerate(description: string, workDir: string, opts: ParsedArgs): Promise<void> {
  if (!description.trim()) {
    console.error('Error: provide a feature description.\nExample: implement-plan generate "build user auth with JWT"')
    process.exit(1)
  }

  const config = loadUserConfig(workDir)
  const registry = setupProviders(config, opts.provider)

  const abortController = new AbortController()
  process.on('SIGINT', () => {
    abortController.abort()
    process.exit(130)
  })

  if (opts.dryRun) {
    console.log(`[DRY RUN] Would generate plan for: "${description}"`)
    console.log(`[DRY RUN] Provider: ${registry.providers[0].name} (haiku)`)
    return
  }

  let planText: string
  try {
    planText = await generatePlan(description, workDir, registry)
  } catch (err: any) {
    console.error(`\nGeneration failed: ${err.message}`)
    process.exit(1)
  }

  if (!planText.trim()) {
    console.error('\nGeneration produced no output. Try again or use a different provider.')
    process.exit(1)
  }

  // Save to ~/.claude/plans/<slug>.md
  const slug = toSlug(description)
  const plansDir = path.join(os.homedir(), '.claude', 'plans')
  fs.mkdirSync(plansDir, { recursive: true })
  const planPath = path.join(plansDir, `${slug}.md`)
  fs.writeFileSync(planPath, planText, 'utf-8')

  if (opts.saveOnly) {
    console.log(`\nSaved: ${planPath}`)
    return
  }

  // Display
  const divider = '─'.repeat(50)
  console.log(`\n${divider}`)
  console.log(planText)
  console.log(divider)
  console.log(`\nSaved: ${planPath}`)

  // Interactive review loop
  while (true) {
    const answer = await prompt('\n[Y]es execute / [e]dit / [s]ave only / [a]bort: ')

    if (answer === '' || answer === 'y' || answer === 'yes') {
      console.log()
      const { ok } = validatePlan(planPath, workDir)
      if (!ok) {
        console.log('\nFix the errors above ([e]dit) before executing.')
        continue
      }
      await runExecute(planPath, workDir, { ...opts, restart: false, fromPhase: 1, dryRun: false })
      return
    }

    if (answer === 'e' || answer === 'edit') {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi'
      spawnSync(editor, [planPath], { stdio: 'inherit' })
      const updated = fs.readFileSync(planPath, 'utf-8')
      console.log(`\n${divider}`)
      console.log(updated)
      console.log(divider)
      continue
    }

    if (answer === 's' || answer === 'save') {
      console.log(`Saved: ${planPath}`)
      console.log(`Run when ready: implement-plan ${planPath}`)
      return
    }

    if (answer === 'a' || answer === 'abort') {
      try { fs.unlinkSync(planPath) } catch {}
      console.log('Aborted.')
      process.exit(0)
    }
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

function runInstallSkill(): void {
  const src = path.join(__dirname, 'skill', 'implement-plan.md')
  if (!fs.existsSync(src)) {
    console.error(`Skill file not found at ${src}. Run 'npm run build' first.`)
    process.exit(1)
  }

  const destDir = path.join(os.homedir(), '.claude', 'commands')
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, 'implement-plan.md')
  fs.copyFileSync(src, dest)

  console.log(`✅ Skill installed: ${dest}`)
  console.log(`   Use /implement-plan <description> in any Claude Code session`)
}

const USAGE = `Usage:
  implement-plan generate <description>         Generate a plan interactively
  implement-plan <plan.md> [options]            Execute an existing plan
  implement-plan validate <plan.md>             Validate plan structure
  implement-plan install-skill                  Install the /implement-plan Claude Code skill

Generate options:
  --save-only           Generate and save without the interactive review
  --dry-run             Show what would be generated without calling the AI
  --provider=claude|codex  Force a specific provider

Execute options:
  --sequential          Run parallel phases serially (saves quota)
  --dry-run             Print prompts without calling the AI
  --from-phase=N        Start from phase N (resume after crash)
  --dirty-ok            Skip git clean check
  --restart             Ignore existing progress file
  --provider=claude|codex  Force a specific provider first`

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
  } else if (opts.subcommand === 'generate') {
    await runGenerate(opts.description, workDir, opts)
  } else if (opts.subcommand === 'install-skill') {
    runInstallSkill()
  } else {
    await runExecute(opts.planPath, workDir, opts)
  }
}

main().catch(err => {
  console.error(err.message ?? err)
  process.exit(1)
})
