import { spawn, execSync, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { Provider, ProviderProgress, ProviderResult, ModelTier } from './types'

const COMPLETION_FILE = '.phase-complete.json'
const outputFiles = new WeakMap<ChildProcess, string>()

export class CodexProvider implements Provider {
  readonly name = 'codex'
  readonly modelMap: Record<ModelTier, string>

  constructor(overrides?: Partial<Record<ModelTier, string>>) {
    this.modelMap = {
      fast: overrides?.fast ?? 'gpt-5.4-mini',
      standard: overrides?.standard ?? 'gpt-5.4',
      powerful: overrides?.powerful ?? 'gpt-5.5',
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
    _bare = true,
  ): ChildProcess {
    // Codex doesn't support --allowedTools or --max-budget-usd
    // Wall-clock timeout in phase-runner is the cost guard
    const outputFile = path.join(workDir, `.codex-last-message-${process.pid}-${Date.now()}.txt`)
    const proc = spawn('codex', [
      'exec',
      '-m', model,
      '--sandbox', 'danger-full-access',
      '--json',      // JSONL structured output
      '--ephemeral', // no session persistence between phases
      '--output-last-message', outputFile,
      '-C', workDir,
      prompt,
    ], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] })
    outputFiles.set(proc, outputFile)
    return proc
  }

  parseStream(proc: ChildProcess, prefix: string, workDir: string, onProgress?: ProviderProgress): Promise<ProviderResult> {
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
        assistantText: '',
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
            const progress = codexProgressLabel(event)
            if (progress) onProgress?.(progress)

            // Codex emits {type: 'message', role: 'assistant', content: '...'} in JSONL
            if (event.type === 'message' && event.role === 'assistant') {
              const text = typeof event.content === 'string'
                ? event.content
                : event.content?.map((c: any) => c.text ?? '').join('')
              if (text?.trim()) {
                if (prefix || !onProgress) process.stdout.write(`${prefix}${text.trim()}\n`)
                result.assistantText += text
              }
            }
            if (event.msg?.type === 'agent_message' && typeof event.msg.message === 'string') {
              const text = event.msg.message
              if (text.trim()) {
                if (prefix || !onProgress) process.stdout.write(`${prefix}${text.trim()}\n`)
                result.assistantText += text
              }
            }
            if (event.type === 'item.completed' && event.item?.type === 'message') {
              const text = extractText(event.item.content)
              if (text.trim()) {
                if (prefix || !onProgress) process.stdout.write(`${prefix}${text.trim()}\n`)
                result.assistantText += text
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
        const outputFile = outputFiles.get(proc)
        if (outputFile) {
          try {
            const finalMessage = fs.readFileSync(outputFile, 'utf-8')
            if (finalMessage.trim() && !result.assistantText?.trim()) {
              result.assistantText = finalMessage
            }
          } catch {
            // Codex may fail before writing the final message file.
          }
          try { fs.unlinkSync(outputFile) } catch {}
          outputFiles.delete(proc)
        }
        if (code !== 0 && stderrBuffer.trim()) {
          result.error = stderrBuffer.trim().slice(0, 500)
        }

        result.rateLimited = this.detectRateLimit(stderrBuffer, result)
        resolve(result)
      })
    })
  }

  detectRateLimit(stderr: string, result: ProviderResult): boolean {
    const haystack = stderr + (result.error ?? '') + (result.assistantText ?? '')
    return /rate.?limit|session limit|too many requests|429|quota exceeded|throttl|concurrency limit|resource exhausted/i.test(haystack)
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: any) => {
    if (typeof part === 'string') return part
    return part?.text ?? part?.content ?? ''
  }).join('')
}

function codexProgressLabel(event: any): string | null {
  if (event.msg?.type === 'agent_reasoning_delta') return 'reasoning'
  if (event.msg?.type === 'agent_message_delta') return 'drafting final response'
  if (event.msg?.type === 'agent_message') return 'final response received'
  if (event.msg?.type === 'exec_command_begin') return `running ${event.msg.command ?? 'command'}`
  if (event.msg?.type === 'exec_command_end') return 'command finished'
  if (event.type === 'turn_started') return 'turn started'
  if (event.type === 'turn_count') return `${event.count ?? '?'} turn${event.count === 1 ? '' : 's'} used`
  if (event.type === 'item.started') return itemProgress(event.item, 'started')
  if (event.type === 'item.completed') return itemProgress(event.item, 'completed')
  if (event.type === 'response.started') return 'model response started'
  if (event.type === 'response.completed') return 'model response completed'
  return null
}

function itemProgress(item: any, state: string): string | null {
  if (!item?.type) return null
  if (item.type === 'reasoning') return state === 'started' ? 'reasoning' : 'reasoning complete'
  if (item.type === 'message') return state === 'started' ? 'drafting final response' : 'final response received'
  if (item.type === 'function_call') return `${state} tool call${item.name ? `: ${item.name}` : ''}`
  return `${state} ${item.type}`
}
