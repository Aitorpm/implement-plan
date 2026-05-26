import * as yaml from 'js-yaml'
import * as fs from 'fs'

export type ModelName = 'haiku' | 'sonnet' | 'opus' | 'auto'

export interface BasePhase {
  id: number
  name: string
  mode: 'serial' | 'parallel'
  model?: ModelName
  allowed_tools?: string[]
  timeout_minutes?: number
}

export interface SerialPhase extends BasePhase {
  mode: 'serial'
  tasks: string[]
  context?: string
  verify: string[]
  project_context_files?: string[]
}

export interface ParallelTeammate {
  name: string
  branch: string
  files: string[]
  tasks: string[]
  context?: string
  verify: string
}

export interface ParallelPhase extends BasePhase {
  mode: 'parallel'
  teammate_A: ParallelTeammate
  teammate_B: ParallelTeammate
  post_parallel_verify: string[]
}

export type Phase = SerialPhase | ParallelPhase

export function parsePlan(filePath: string): Phase[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')

  const startIdx = lines.findIndex(l => /^phases:/.test(l))
  if (startIdx === -1) throw new Error(`No 'phases:' block found in ${filePath}`)

  // End at the next top-level markdown heading or end of file
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#/.test(lines[i])) {
      endIdx = i
      break
    }
  }

  const yamlBlock = lines.slice(startIdx, endIdx).join('\n')
  const parsed = yaml.load(yamlBlock) as { phases: Phase[] }

  if (!parsed?.phases || !Array.isArray(parsed.phases)) {
    throw new Error(`Invalid plan: 'phases' must be an array`)
  }

  return parsed.phases
}
