import { spawn, ChildProcess } from 'child_process'
import { execSync } from 'child_process'
import { Provider, ProviderResult, ModelTier } from './types'

export class ClaudeProvider implements Provider {
  readonly name = 'claude'
  readonly modelMap: Record<ModelTier, string>

  constructor(overrides?: Partial<Record<ModelTier, string>>) {
    this.modelMap = {
      fast: overrides?.fast ?? 'haiku',
      standard: overrides?.standard ?? 'sonnet',
      powerful: overrides?.powerful ?? 'opus',
    }
  }

  isInstalled(): boolean {
    try {
      execSync('which claude', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  spawn(
    prompt: string,
    model: string,
    allowedTools: string,
    workDir: string,
    budgetUsd: number,
  ): ChildProcess {
    return spawn('claude', [
      '-p', prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--allowedTools', allowedTools,
      '--max-budget-usd', String(budgetUsd.toFixed(2)),
      '--bare',
    ], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  parseStream(proc: ChildProcess, prefix: string, _workDir: string): Promise<ProviderResult> {
    return new Promise((resolve) => {
      let buffer = ''
      let lineBuffer = ''
      let stderrBuffer = ''

      const result: ProviderResult = {
        success: false,
        rateLimited: false,
        costUsd: 0,
        numTurns: 0,
        hasCompletionFile: false,
        filesWritten: [],
      }

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString()
      })

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        buffer += text
        lineBuffer += text

        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'assistant') {
              const textContent = event.message?.content
                ?.filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('')
              if (textContent?.trim()) {
                process.stdout.write(`${prefix}${textContent.trim()}\n`)
              }
            }
          } catch {
            // partial line — skip display
          }
        }
      })

      proc.on('close', () => {
        const lines = buffer.trim().split('\n').filter(Boolean)

        for (const line of lines) {
          try {
            const event = JSON.parse(line)

            if (event.type === 'result') {
              result.success = event.subtype === 'success'
              result.costUsd = event.total_cost_usd ?? 0
              result.numTurns = event.num_turns ?? 0
              if (event.subtype !== 'success') {
                result.error = event.subtype
              }
            }

            if (event.type === 'tool_use' && (event.name === 'Write' || event.name === 'Edit')) {
              const filePath = event.input?.file_path
              if (filePath) {
                if (!result.filesWritten.includes(filePath)) result.filesWritten.push(filePath)
                if (filePath.endsWith('.phase-complete.json')) result.hasCompletionFile = true
              }
            }
          } catch {
            // non-JSON line — ignore
          }
        }

        result.rateLimited = this.detectRateLimit(stderrBuffer, result)
        resolve(result)
      })
    })
  }

  detectRateLimit(stderr: string, result: ProviderResult): boolean {
    const haystack = stderr + (result.error ?? '')
    return /rate.?limit|too many requests|429|quota exceeded|throttl|concurrency limit|resource exhausted/i.test(haystack)
  }
}
