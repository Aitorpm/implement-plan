import * as fs from 'fs'
import * as path from 'path'

export interface GenerateInput {
  description: string
  slugSeed: string
  source?: string
}

export function resolveGenerateInput(input: string, workDir: string): GenerateInput {
  const trimmed = input.trim()
  if (!trimmed) return { description: '', slugSeed: '' }

  const candidates = [
    path.resolve(workDir, trimmed),
    path.resolve(trimmed),
  ]

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return {
          description: fs.readFileSync(candidate, 'utf-8'),
          slugSeed: path.basename(candidate, path.extname(candidate)),
          source: candidate,
        }
      }
    } catch {
      // Fall back to treating the input as a natural language description.
    }
  }

  return { description: trimmed, slugSeed: trimmed }
}
