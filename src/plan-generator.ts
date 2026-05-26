import * as fs from 'fs'
import * as path from 'path'
import { ProviderRegistry } from './providers/registry'
import { loadProjectDocs } from './context-loader'

const GENERATION_BUDGET_USD = 0.10
const GENERATION_TIMEOUT_MS = 2 * 60 * 1000

export async function generatePlan(
  description: string,
  workDir: string,
  registry: ProviderRegistry,
): Promise<string> {
  const provider = registry.getAvailable()
  if (!provider) {
    throw new Error('No providers available for plan generation')
  }

  const projectDocs = loadProjectDocs(workDir)
  const guideContent = readStaticFile('PLAN_WRITING_GUIDE.md')
  const templateContent = readStaticFile('examples/plan-template.md')

  const prompt = buildGenerationPrompt(description, projectDocs, guideContent, templateContent)

  console.log(`  Generating plan with ${provider.name} (fast)...`)

  const model = provider.modelMap['fast']
  const proc = provider.spawn(prompt, model, 'Read', workDir, GENERATION_BUDGET_USD)

  return new Promise((resolve, reject) => {
    let lineBuffer = ''
    let textOutput = ''
    let stderrBuffer = ''
    let done = false

    const timer = setTimeout(() => {
      if (!done) {
        done = true
        proc.kill('SIGTERM')
        reject(new Error('Generation timed out after 2 minutes'))
      }
    }, GENERATION_TIMEOUT_MS)

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString()
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          // Claude stream-json: text from assistant events
          if (event.type === 'assistant') {
            const content: string = event.message?.content
              ?.filter((c: any) => c.type === 'text')
              .map((c: any) => c.text as string)
              .join('') ?? ''
            if (content) textOutput += content
          }
          // Codex JSONL: text from message events
          if (event.type === 'message' && event.role === 'assistant') {
            const content: string = typeof event.content === 'string'
              ? event.content
              : (event.content as any[])?.map((c: any) => c.text ?? '').join('') ?? ''
            if (content) textOutput += content
          }
        } catch {
          // non-JSON line — skip
        }
      }
    })

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (!done) {
        done = true
        if (!textOutput && code !== 0) {
          reject(new Error(`${provider.name} exited with code ${code}: ${stderrBuffer.slice(0, 300)}`))
        } else {
          resolve(textOutput.trim())
        }
      }
    })
  })
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

export function toSlug(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, maxLen)
    .replace(/-+$/, '')
}
