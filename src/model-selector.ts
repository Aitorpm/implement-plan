import { Phase, SerialPhase, ParallelPhase } from './plan-parser'
import { ModelTier } from './providers/types'

const HAIKU_KEYWORDS = [
  'create file', 'add import', 'scaffold', 'generate', 'migrate',
  'rename', 'move', 'constant', 'barrel export', 'run command', 'copy',
]

const SONNET_KEYWORDS = [
  'implement', 'algorithm', 'calculate', 'pure function', 'spec', 'test',
  'service', 'engine', 'state machine', 'edge case', 'handle error',
  'interface', 'type guard', 'middleware',
]

const TEST_SUITE_PATTERNS = ['vitest', 'jest', 'pytest', 'go test', 'pnpm test', 'npm test']

const COMPLEX_FILE_PATTERNS = ['.spec.ts', '.test.ts', 'engine.ts', 'service.ts', '.spec.js', '.test.js']

export function selectModel(phase: Phase): { model: ModelTier; score: number } {
  let score = 0

  const allTasks = phase.mode === 'serial'
    ? (phase as SerialPhase).tasks
    : [
        ...(phase as ParallelPhase).teammate_A.tasks,
        ...(phase as ParallelPhase).teammate_B.tasks,
      ]

  const allVerify = phase.mode === 'serial'
    ? (phase as SerialPhase).verify
    : (phase as ParallelPhase).post_parallel_verify

  const allFiles = phase.mode === 'parallel'
    ? [
        ...(phase as ParallelPhase).teammate_A.files,
        ...(phase as ParallelPhase).teammate_B.files,
      ]
    : []

  const taskText = allTasks.join(' ').toLowerCase()
  const verifyText = allVerify.join(' ').toLowerCase()

  // Haiku signals
  for (const kw of HAIKU_KEYWORDS) {
    if (taskText.includes(kw)) score -= 1
  }
  if (allTasks.length <= 3) score -= 1
  if (allVerify.every(v => v.startsWith('test -') || v.startsWith('grep -'))) score -= 1

  // Sonnet signals
  for (const kw of SONNET_KEYWORDS) {
    if (taskText.includes(kw)) score += 2
  }
  if (allTasks.length >= 5) score += 2
  if (phase.mode === 'parallel') score += 2
  if (TEST_SUITE_PATTERNS.some(p => verifyText.includes(p))) score += 2
  for (const pattern of COMPLEX_FILE_PATTERNS) {
    if (allFiles.some(f => f.endsWith(pattern))) score += 1
  }

  const model: ModelTier = score >= 3 ? 'sonnet' : 'haiku'
  return { model, score }
}
