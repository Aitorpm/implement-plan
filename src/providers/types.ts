import { ChildProcess } from 'child_process'

export type ModelTier = 'fast' | 'standard' | 'powerful'

export interface ProviderResult {
  success: boolean
  rateLimited: boolean
  costUsd: number
  numTurns: number
  hasCompletionFile: boolean
  filesWritten: string[]
  error?: string
}

export interface Provider {
  readonly name: string
  readonly modelMap: Record<ModelTier, string>

  isInstalled(): boolean

  spawn(
    prompt: string,
    model: string,
    allowedTools: string,
    workDir: string,
    budgetUsd: number,
  ): ChildProcess

  parseStream(proc: ChildProcess, prefix: string, workDir: string): Promise<ProviderResult>
  detectRateLimit(stderr: string, result: ProviderResult): boolean
}
