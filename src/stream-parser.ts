import { ChildProcess } from 'child_process'

export interface StreamResult {
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'cancelled' | 'timeout'
  totalCostUsd: number
  numTurns: number
  hasCompletionFile: boolean
  filesWritten: string[]
  lastError?: string
}

export function parseStreamWithTee(proc: ChildProcess, prefix: string): Promise<StreamResult> {
  return new Promise((resolve) => {
    let buffer = ''
    let lineBuffer = ''

    const result: StreamResult = {
      subtype: 'error_during_execution',
      totalCostUsd: 0,
      numTurns: 0,
      hasCompletionFile: false,
      filesWritten: [],
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      buffer += text
      lineBuffer += text

      // Process complete lines for tee display
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
          // non-JSON or partial line — skip display
        }
      }
    })

    proc.on('close', () => {
      const lines = buffer.trim().split('\n').filter(Boolean)

      for (const line of lines) {
        try {
          const event = JSON.parse(line)

          if (event.type === 'result') {
            result.subtype = event.subtype ?? 'error_during_execution'
            result.totalCostUsd = event.total_cost_usd ?? 0
            result.numTurns = event.num_turns ?? 0
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

      resolve(result)
    })
  })
}
