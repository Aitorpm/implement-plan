import { Phase, SerialPhase, ParallelPhase, parsePlan } from './plan-parser'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

interface ValidationResult {
  errors: string[]
  warnings: string[]
}

const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus', 'auto'])
const VALID_PROVIDERS = new Set(['claude', 'codex'])

function looksLikeShellCommand(cmd: string): boolean {
  const firstWord = cmd.trim().split(/\s+/)[0]
  return /^(test|grep|ls|cat|echo|pnpm|npm|npx|yarn|bun|node|python|python3|go|cargo|make|bash|sh|git|tsc|vitest|jest|pytest|find|curl|mkdir|cp|mv|rm|chmod|\.|\/|\$)/.test(firstWord)
}

function validateSerialPhase(phase: SerialPhase): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!phase.tasks?.length) {
    errors.push(`Phase ${phase.id}: 'tasks' is empty or missing`)
  } else if (phase.tasks.length > 8) {
    warnings.push(`Phase ${phase.id}: ${phase.tasks.length} tasks — consider splitting (>8 risks hitting turn limit)`)
  }

  if (!phase.verify?.length) {
    errors.push(`Phase ${phase.id}: 'verify' is empty or missing`)
  } else {
    for (const cmd of phase.verify) {
      if (!looksLikeShellCommand(cmd)) {
        errors.push(`Phase ${phase.id}: verify looks like prose, not a shell command: "${cmd}"`)
      }
    }
  }

  return { errors, warnings }
}

function validateParallelPhase(phase: ParallelPhase): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!phase.teammate_A) errors.push(`Phase ${phase.id}: missing 'teammate_A'`)
  if (!phase.teammate_B) errors.push(`Phase ${phase.id}: missing 'teammate_B'`)

  if (phase.teammate_A && phase.teammate_B) {
    const filesA = new Set(phase.teammate_A.files ?? [])
    const filesB = new Set(phase.teammate_B.files ?? [])
    const overlap = [...filesA].filter(f => filesB.has(f))
    if (overlap.length > 0) {
      errors.push(`Phase ${phase.id}: file overlap between teammates: ${overlap.join(', ')}`)
    }

    if (!phase.teammate_A.verify) errors.push(`Phase ${phase.id}: teammate_A missing 'verify'`)
    if (!phase.teammate_B.verify) errors.push(`Phase ${phase.id}: teammate_B missing 'verify'`)

    const tasksA = phase.teammate_A.tasks?.length ?? 0
    const tasksB = phase.teammate_B.tasks?.length ?? 0
    if (tasksA > 8) warnings.push(`Phase ${phase.id} teammate_A: ${tasksA} tasks — consider splitting`)
    if (tasksB > 8) warnings.push(`Phase ${phase.id} teammate_B: ${tasksB} tasks — consider splitting`)
  }

  if (!phase.post_parallel_verify?.length) {
    errors.push(`Phase ${phase.id}: 'post_parallel_verify' is empty or missing`)
  }

  return { errors, warnings }
}

export function validatePlan(planPath: string, workDir: string): { ok: boolean } {
  console.log(`\nValidating: ${path.basename(planPath)}`)

  let phases: Phase[]
  try {
    phases = parsePlan(planPath)
    console.log(`  ✅ YAML parses cleanly — ${phases.length} phase${phases.length === 1 ? '' : 's'} found`)
  } catch (err: any) {
    console.log(`  ❌ YAML parse error: ${err.message}`)
    console.log(`\nResult: 1 error. Fix before running.\n`)
    return { ok: false }
  }

  const allErrors: string[] = []
  const allWarnings: string[] = []

  // Check at least one provider in PATH
  const hasClaude = (() => { try { execSync('which claude', { stdio: 'ignore' }); return true } catch { return false } })()
  const hasCodex = (() => { try { execSync('which codex', { stdio: 'ignore' }); return true } catch { return false } })()
  if (!hasClaude && !hasCodex) {
    const msg = `No AI provider found in PATH — install Claude Code CLI ('claude') or OpenAI Codex CLI ('codex')`
    console.log(`  ❌ ${msg}`)
    allErrors.push(msg)
  } else {
    const found = [hasClaude && 'claude', hasCodex && 'codex'].filter(Boolean).join(', ')
    console.log(`  ✅ Provider(s) found in PATH: ${found}`)
  }

  // Check git repo (needed for parallel phases)
  const hasParallel = phases.some(p => p.mode === 'parallel')
  if (hasParallel && !fs.existsSync(path.join(workDir, '.git'))) {
    const msg = `Not a git repository — parallel phases require git (run 'git init')`
    console.log(`  ⚠️  ${msg}`)
    allWarnings.push(msg)
  }

  for (const phase of phases) {
    // Model validation
    if (phase.model && !VALID_MODELS.has(phase.model)) {
      const msg = `Phase ${phase.id}: invalid model '${phase.model}' — must be haiku, sonnet, opus, or auto`
      console.log(`  ❌ ${msg}`)
      allErrors.push(msg)
    } else {
      console.log(`  ✅ Phase ${phase.id}: model valid (${phase.model ?? 'auto'})`)
    }

    // Provider validation
    if (phase.provider && !VALID_PROVIDERS.has(phase.provider)) {
      const msg = `Phase ${phase.id}: invalid provider '${phase.provider}' — must be claude or codex`
      console.log(`  ❌ ${msg}`)
      allErrors.push(msg)
    } else if (phase.provider) {
      console.log(`  ✅ Phase ${phase.id}: provider hint set to '${phase.provider}'`)
    }

    const { errors, warnings } = phase.mode === 'serial'
      ? validateSerialPhase(phase as SerialPhase)
      : validateParallelPhase(phase as ParallelPhase)

    for (const err of errors) {
      console.log(`  ❌ ${err}`)
      allErrors.push(err)
    }
    for (const warn of warnings) {
      console.log(`  ⚠️  ${warn}`)
      allWarnings.push(warn)
    }

    if (errors.length === 0) {
      if (phase.mode === 'parallel') {
        console.log(`  ✅ Phase ${phase.id}: parallel — no file overlap between teammates`)
      } else if (warnings.length === 0) {
        console.log(`  ✅ Phase ${phase.id}: structure valid`)
      }
    }
  }

  const ec = allErrors.length
  const wc = allWarnings.length

  if (ec === 0 && wc === 0) {
    console.log(`\nResult: all checks passed. Ready to run.\n`)
  } else {
    const parts = [
      ec > 0 ? `${ec} error${ec === 1 ? '' : 's'}` : '',
      wc > 0 ? `${wc} warning${wc === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ')
    console.log(`\nResult: ${parts}.${ec > 0 ? ' Fix errors before running.' : ''}\n`)
  }

  return { ok: ec === 0 }
}
