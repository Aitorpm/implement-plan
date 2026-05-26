import { spawn, execSync, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Provider, ProviderResult, ModelTier } from './types'

const COMPLETION_FILE = '.phase-complete.json'

export class CodexProvider implements Provider {
  readonly name = 'codex'
  readonly modelMap: Record<ModelTier, string>

  constructor(overrides?: Partial<Record<ModelTier, string>>) {
    this.modelMap = {
      haiku: overrides?.haiku ?? 'gpt-5.4-mini',
      sonnet: overrides?.sonnet ?? 'gpt-5.4',
      opus: overrides?.opus ?? 'gpt-5.5',
    }
  }

  isInstalled(): boolean {
    try {
      execSync('which codex', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  spawn(
    prompt: string,
    model: string,
    _allowedTools: string,
    workDir: string,
    _budgetUsd: number,
  ): ChildProcess {
    // Codex doesn't support --allowedTools or --max-budget-usd
    // Wall-clock timeout in phase-runner is the cost guard
    return spawn('codex', [
      'exec',
      '-m', model,
      '--sandbox', 'danger-full-access',
      '--json',      // JSONL structured output
      '--ephemeral', // no session persistence between phases
      '-C', workDir,
      prompt,
    ], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  parseStream(proc: ChildProcess, prefix: string, workDir: string): Promise<ProviderResult> {
    return new Promise((resolve) => {
      let lineBuffer = ''
      let stderrBuffer = ''

      const result: ProviderResult = {
        success: false,
        rateLimited: false,
        costUsd: 0,   // Codex CLI does not report per-invocation cost
        numTurns: 0,
        hasCompletionFile: false,
        filesWritten: [],
      }

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString()
      })

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        lineBuffer += text

        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            // Codex emits {type: 'message', role: 'assistant', content: '...'} in JSONL
            if (event.type === 'message' && event.role === 'assistant') {
              const text = typeof event.content === 'string'
                ? event.content
                : event.content?.map((c: any) => c.text ?? '').join('')
              if (text?.trim()) {
                process.stdout.write(`${prefix}${text.trim()}\n`)
              }
            }
            if (event.type === 'turn_count') {
              result.numTurns = event.count ?? result.numTurns
            }
          } catch {
            // non-JSON or partial line — skip
          }
        }
      })

      proc.on('close', (code) => {
        // Derive filesWritten from git diff (Codex has no tool_use events)
        try {
          const diff = execSync('git diff --name-only HEAD', { cwd: workDir, encoding: 'utf-8' })
          result.filesWritten = diff.split('\n').filter(Boolean)
        } catch {
          // not a git repo or no commits — leave empty
        }

        result.hasCompletionFile = fs.existsSync(path.join(workDir, COMPLETION_FILE))
        result.success = code === 0
        if (code !== 0 && stderrBuffer.trim()) {
          result.error = stderrBuffer.trim().slice(0, 500)
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
