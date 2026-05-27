#!/usr/bin/env node
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as readline from 'readline'
import { execSync } from 'child_process'
import { parsePlan, Phase } from './plan-parser'
import { runPhase, PhaseResult, activeWorktrees } from './phase-runner'
import { PlanValidationSummary, validatePlan } from './plan-validator'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { ProviderRegistry } from './providers/registry'
import { ModelTier } from './providers/types'
import { generatePlan, revisePlan, toSlug } from './plan-generator'
import { resolveGenerateInput } from './cli-input'
import { loadPriorPhaseFiles } from './context-loader'
import { selectModel } from './model-selector'

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
  yes: boolean
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
    yes: false,
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
    fromPhase: (parseInt(rest.find(a => a.startsWith('--from-phase='))?.split('=')[1] ?? '1', 10) || 1),
    provider: providerArg,
    yes: rest.includes('--yes') || rest.includes('-y'),
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

function promptRaw(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function reviseSavedPlan(
  planPath: string,
  workDir: string,
  registry: ProviderRegistry,
  instruction: string,
): Promise<void> {
  const currentPlan = fs.readFileSync(planPath, 'utf-8')
  const revised = await revisePlan(currentPlan, instruction, workDir, registry)
  if (!revised.trim()) {
    throw new Error('Plan revision produced no output')
  }
  fs.writeFileSync(planPath, revised, 'utf-8')
}

async function autoFixPlanUntilValid(
  planPath: string,
  workDir: string,
  registry: ProviderRegistry,
  initialValidation: PlanValidationSummary,
): Promise<boolean> {
  let validation = initialValidation
  for (let attempt = 1; attempt <= 3; attempt++) {
    const detail = [
      ...validation.errors.map(e => `ERROR: ${e}`),
      ...validation.warnings.map(w => `WARNING: ${w}`),
    ].join('\n')
    console.log(`  Auto-fixing plan validation issue${validation.errors.length === 1 ? '' : 's'} (attempt ${attempt}/3)...`)
    await reviseSavedPlan(
      planPath,
      workDir,
      registry,
      `Fix these validation problems while preserving the user's intended feature scope. The corrected plan must pass implement-plan validate.\n${detail}`,
    )

    validation = validatePlan(planPath, workDir)
    if (validation.ok) return true
  }

  return false
}

async function runGenerate(description: string, workDir: string, opts: ParsedArgs): Promise<void> {
  const input = resolveGenerateInput(description, workDir)
  if (!input.description.trim()) {
    console.error('Error: provide a feature description or a file path.\nExample: implement-plan generate "build user auth with JWT"\nExample: implement-plan generate ./feature-plan.md')
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
    const source = input.source ? ` from file: ${input.source}` : ` for: "${input.description}"`
    console.log(`[DRY RUN] Would generate plan${source}`)
    console.log(`[DRY RUN] Provider: ${registry.providers[0].name} (haiku)`)
    return
  }

  let planText: string
  try {
    if (input.source) {
      console.log(`  Reading plan request from ${input.source}`)
    }
    planText = await generatePlan(input.description, workDir, registry)
  } catch (err: any) {
    console.error(`\nGeneration failed: ${err.message}`)
    process.exit(1)
  }

  if (!planText.trim()) {
    console.error('\nGeneration produced no output. Try again or use a different provider.')
    process.exit(1)
  }

  // Save to ~/.claude/plans/<slug>.md
  const slug = toSlug(input.slugSeed)
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
    const answer = await prompt('\n[Y]es execute / [r]evise with prompt / [s]ave only / [a]bort: ')

    if (answer === '' || answer === 'y' || answer === 'yes') {
      console.log()
      const validation = validatePlan(planPath, workDir)
      if (!validation.ok) {
        const fixed = await autoFixPlanUntilValid(planPath, workDir, registry, validation)
        if (!fixed) {
          console.log(`\nCould not auto-fix the generated plan after 3 attempts. Saved: ${planPath}`)
          console.log(`Run when ready: implement-plan generate "${description}"`)
          return
        }
        const updated = fs.readFileSync(planPath, 'utf-8')
        console.log(`\n${divider}`)
        console.log(updated)
        console.log(divider)
        console.log(`\nAuto-fixed: ${planPath}`)
      }
      try {
        await runExecute(planPath, workDir, { ...opts, restart: false, fromPhase: 1, dryRun: false, yes: true })
      } catch (err: any) {
        console.error(err.message ?? err)
        process.exit(1)
      }
      return
    }

    if (answer === 'r' || answer === 'revise' || answer === 'e' || answer === 'edit') {
      const instruction = await promptRaw('\nDescribe the plan change: ')
      if (!instruction.trim()) {
        continue
      }
      await reviseSavedPlan(planPath, workDir, registry, instruction)
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

function printPlanSummary(phases: Phase[]): void {
  const TIER_LABEL: Record<string, string> = { fast: 'haiku', standard: 'sonnet', powerful: 'opus' }

  const rows = phases.map(p => {
    const agentCount = p.mode === 'parallel' ? 2 : 1
    const modelLabel = (p.model && p.model !== 'auto')
      ? p.model
      : `~${TIER_LABEL[selectModel(p, 0).model]}`
    const teammates = p.mode === 'parallel'
      ? `  A: ${(p as any).teammate_A.name} · B: ${(p as any).teammate_B.name}`
      : ''
    return { id: String(p.id), name: p.name, mode: p.mode, model: modelLabel, agents: String(agentCount), teammates }
  })

  const colW = {
    id: Math.max(1, ...rows.map(r => r.id.length)),
    name: Math.max(4, ...rows.map(r => r.name.length)),
    mode: 8,
    model: Math.max(5, ...rows.map(r => r.model.length)),
    agents: 6,
  }

  const divider = '  ' + '─'.repeat(colW.id + colW.name + colW.mode + colW.model + colW.agents + 12)

  console.log(`\n  ${'#'.padEnd(colW.id)}  ${'Name'.padEnd(colW.name)}  ${'Mode'.padEnd(colW.mode)}  ${'Model'.padEnd(colW.model)}  Agents`)
  console.log(divider)
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(colW.id)}  ${r.name.padEnd(colW.name)}  ${r.mode.padEnd(colW.mode)}  ${r.model.padEnd(colW.model)}  ${r.agents}${r.teammates}`)
  }
  console.log(divider)

  const totalAgents = rows.reduce((s, r) => s + Number(r.agents), 0)
  console.log(`  ${phases.length} phase${phases.length === 1 ? '' : 's'} · ${totalAgents} agent${totalAgents === 1 ? '' : 's'} total\n`)
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
  if (flags.length) console.log(`Flags: ${flags.join(', ')}`)
  printPlanSummary(phases)

  if (!opts.yes && !opts.dryRun && process.stdin.isTTY) {
    const answer = await prompt('Execute this plan? [y/n]: ')
    if (answer !== 'y' && answer !== 'yes' && answer !== '') {
      console.log('Aborted.')
      process.exit(0)
    }
    console.log()
  }

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
  // Accumulated list of every file changed across all completed phases. Priority-sorted
  // when read, so schema/constants/types always surface to the top regardless of which
  // phase produced them.
  const allPriorChangedFiles: string[] = []
  let priorPhaseFiles: string | undefined

  for (const [index, phase] of phases.entries()) {
    const result = await runPhase(phase, workDir, registry, abortController.signal, {
      sequential: opts.sequential,
      dryRun: opts.dryRun,
      phaseIndex: index + 1,
      totalPhases: phases.length,
      forcedProvider: opts.provider,
      priorPhaseFiles,
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

    const doneCount = index + 1
    const elapsedS = Math.round((Date.now() - start) / 1000)
    const elapsedStr = elapsedS >= 60 ? `${Math.floor(elapsedS / 60)}m ${elapsedS % 60}s` : `${elapsedS}s`
    const costStr = totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ''
    console.log(`  ── ${doneCount} / ${phases.length} phases done${costStr} · ${elapsedStr}`)

    // After each phase, accumulate all changed files (tool-tracked + git) so every
    // subsequent phase sees the complete real output of every prior phase.
    if (!opts.dryRun) {
      try {
        const gitChanged = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || true', {
          cwd: workDir, encoding: 'utf-8',
        }).trim().split('\n').filter(Boolean)
        for (const f of [...result.filesWritten, ...gitChanged]) {
          if (!allPriorChangedFiles.includes(f)) allPriorChangedFiles.push(f)
        }
      } catch {
        for (const f of result.filesWritten) {
          if (!allPriorChangedFiles.includes(f)) allPriorChangedFiles.push(f)
        }
      }
      if (allPriorChangedFiles.length > 0) {
        priorPhaseFiles = loadPriorPhaseFiles(workDir, allPriorChangedFiles)
      }
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
  console.log(`   (Codex users: run 'implement-plan generate <description>' directly from the terminal)`)
}

const USAGE = `Usage:
  implement-plan generate <description|file>    Generate a plan interactively
  implement-plan <plan.md> [options]            Execute an existing plan
  implement-plan validate <plan.md>             Validate plan structure
  implement-plan install-skill                  Install the /implement-plan Claude Code skill

Generate options:
  --save-only           Generate and save without the interactive review
  --dry-run             Show what would be generated without calling the AI
  --provider=claude|codex  Force a specific provider

Execute options:
  --yes, -y             Skip the pre-execution confirmation prompt
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
