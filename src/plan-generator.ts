import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { ProviderRegistry } from './providers/registry'
import { Provider } from './providers/types'
import { loadProjectDocs } from './context-loader'

const GENERATION_BUDGET_USD = 0.10
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000

export async function generatePlan(
  description: string,
  workDir: string,
  registry: ProviderRegistry,
): Promise<string> {
  const projectDocs = loadProjectDocs(workDir)
  const guideContent = readStaticFile('PLAN_WRITING_GUIDE.md')
  const templateContent = readStaticFile('examples/plan-template.md')

  const prompt = buildGenerationPrompt(description, projectDocs, guideContent, templateContent)

  return runPlanPromptWithFailover(prompt, workDir, registry, 'Generating plan')
}

export async function revisePlan(
  currentPlan: string,
  instruction: string,
  workDir: string,
  registry: ProviderRegistry,
): Promise<string> {
  const guideContent = readStaticFile('PLAN_WRITING_GUIDE.md')
  const templateContent = readStaticFile('examples/plan-template.md')
  const prompt = buildRevisionPrompt(currentPlan, instruction, guideContent, templateContent)

  return runPlanPromptWithFailover(prompt, workDir, registry, 'Revising plan')
}

async function runPlanPromptWithFailover(
  prompt: string,
  workDir: string,
  registry: ProviderRegistry,
  label: string,
): Promise<string> {
  const failures: string[] = []

  while (true) {
    const provider = registry.getAvailable()
    if (!provider) {
      throw new Error(`Plan generation failed${failures.length ? ` (${failures.join('; ')})` : ': no providers available'}`)
    }

    console.log(`  ${label} with ${provider.name} (fast)...`)

    const result = await runPlanPrompt(provider, prompt, workDir)
    if (result.rateLimited) {
      failures.push(`${provider.name}: rate limited`)
      console.log(`  ⚠ ${provider.name} rate-limited during plan generation — trying next provider`)
      registry.markRateLimitedForPhase(provider.name)
      continue
    }

    if (!result.ok) {
      failures.push(`${provider.name}: ${result.error ?? 'failed'}`)
      registry.markRateLimitedForPhase(provider.name)
      continue
    }

    if (!result.text.trim()) {
      failures.push(`${provider.name}: completed without a final assistant message`)
      registry.markRateLimitedForPhase(provider.name)
      continue
    }

    return result.text.trim()
  }
}

function runPlanPrompt(
  provider: Provider,
  prompt: string,
  workDir: string,
): Promise<{ ok: boolean; text: string; rateLimited: boolean; error?: string }> {
  const model = provider.modelMap['fast']
  const proc = provider.spawn(prompt, model, 'Read', workDir, GENERATION_BUDGET_USD, false)

  return runWithTimeoutAndHeartbeat(provider, proc, workDir)
}

async function runWithTimeoutAndHeartbeat(
  provider: Provider,
  proc: ReturnType<Provider['spawn']>,
  workDir: string,
): Promise<{ ok: boolean; text: string; rateLimited: boolean; error?: string }> {
  const status = new StatusLine(provider.name, GENERATION_TIMEOUT_MS)
  let timedOut = false

  status.update('started')
  const quietReminder = setInterval(() => status.remindIfQuiet(), 45_000)

  const timer = setTimeout(() => {
    timedOut = true
    status.update('timed out; stopping provider')
    proc.kill('SIGTERM')
  }, GENERATION_TIMEOUT_MS)

  try {
    const result = await provider.parseStream(proc, '', workDir, message => status.update(message))
    const text = result.assistantText?.trim() ?? ''

    status.done(result.rateLimited ? 'rate limited' : result.success ? 'completed' : 'failed')

    if (timedOut) {
      return { ok: false, text, rateLimited: false, error: 'timed out after 2 minutes' }
    }

    return {
      ok: result.success,
      text,
      rateLimited: result.rateLimited,
      error: result.error,
    }
  } finally {
    clearTimeout(timer)
    clearInterval(quietReminder)
    status.close()
  }
}

class StatusLine {
  private readonly startedAt = Date.now()
  private lastMessage = ''
  private lastWriteAt = 0
  private closed = false

  constructor(
    private readonly providerName: string,
    private readonly timeoutMs: number,
  ) {}

  update(message: string): void {
    if (this.closed) return
    if (message === this.lastMessage && Date.now() - this.lastWriteAt < 10_000) return
    this.lastMessage = message
    this.write(message)
  }

  remindIfQuiet(): void {
    if (this.closed) return
    if (Date.now() - this.lastWriteAt < 45_000) return
    this.write(this.lastMessage || 'waiting for provider')
  }

  done(message: string): void {
    if (this.closed) return
    this.write(message)
    this.close()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (process.stdout.isTTY) {
      process.stdout.write('\n')
    }
  }

  private write(message: string): void {
    this.lastWriteAt = Date.now()
    const elapsed = Date.now() - this.startedAt
    const remaining = Math.max(0, this.timeoutMs - elapsed)
    const line = `  ${this.providerName}: ${message} (${fmt(elapsed)} elapsed, timeout in ${fmt(remaining)})`

    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      process.stdout.write(line)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

function readStaticFile(relativePath: string): string {
  // After `npm run build && npm link`, __dirname is the dist/ directory.
  // postbuild copies PLAN_WRITING_GUIDE.md and examples/ into dist/.
  const candidates = [
    path.join(__dirname, '..', relativePath),  // dist/../ (repo root)
    path.join(__dirname, relativePath),         // dist/<file>
    path.join(process.cwd(), relativePath),     // cwd fallback
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8')
    } catch {
      // try next
    }
  }
  return ''
}

function buildGenerationPrompt(
  description: string,
  projectDocs: string,
  guideContent: string,
  templateContent: string,
): string {
  const sections: string[] = []

  sections.push(
    `You are writing an implementation plan for the \`implement-plan\` orchestrator.\n\n` +
    `Output ONLY the markdown plan file — start with a # heading, include a one-sentence description, then the phases: YAML block. ` +
    `No preamble. No code fences around the whole file. No commentary after.`
  )

  if (projectDocs) {
    sections.push(`PROJECT CONVENTIONS:\n${projectDocs}`)
  }

  if (guideContent) {
    sections.push(`PLAN WRITING RULES:\n${guideContent}`)
  }

  if (templateContent) {
    sections.push(`FORMAT TEMPLATE (follow this structure exactly):\n${templateContent}`)
  }

  sections.push(`FEATURE TO IMPLEMENT:\n${description}`)

  return sections.join('\n\n---\n\n')
}

function buildRevisionPrompt(
  currentPlan: string,
  instruction: string,
  guideContent: string,
  templateContent: string,
): string {
  const sections: string[] = []

  sections.push(
    `You are revising an implementation plan for the \`implement-plan\` orchestrator.\n\n` +
    `Return the COMPLETE corrected markdown plan file only. Start with a # heading, include a short description, then a valid phases: YAML block. ` +
    `Do not include preamble, explanations, code fences around the whole file, or commentary after the plan.`
  )

  sections.push(`REVISION INSTRUCTIONS:\n${instruction}`)

  if (guideContent) {
    sections.push(`PLAN WRITING RULES:\n${guideContent}`)
  }

  if (templateContent) {
    sections.push(`FORMAT TEMPLATE (follow this structure exactly):\n${templateContent}`)
  }

  sections.push(`CURRENT PLAN TO REWRITE:\n${currentPlan}`)

  return sections.join('\n\n---\n\n')
}

export function toSlug(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, maxLen)
    .replace(/-+$/, '')
}
