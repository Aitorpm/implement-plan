import { Phase, SerialPhase, ParallelPhase } from './plan-parser'
import { ModelTier } from './providers/types'

const HAIKU_KEYWORDS = [
  'create file', 'add import', 'scaffold', 'generate', 'migrate',
  'rename', 'move', 'constant', 'barrel export', 'run command', 'copy',
]

const SONNET_KEYWORDS = [
  'implement', 'algorithm', 'calculate', 'pure function', 'spec', 'test',
  'service', 'engine', 'state machine', 'edge case', 'handle error',
  'interface', 'type guard', 'middleware', 'streaming', 'complex',
]

// AI/agent work — these warrant Opus
const OPUS_KEYWORDS = [
  'agent', 'orchestrat', 'multi-agent', 'ai tool', 'tool call',
  'function call', 'llm', 'embedding', 'vector store',
]

const TEST_SUITE_PATTERNS = ['vitest', 'jest', 'pytest', 'go test', 'pnpm test', 'npm test']

const COMPLEX_FILE_PATTERNS = ['.spec.ts', '.test.ts', 'engine.ts', 'service.ts', '.spec.js', '.test.js']
const OPUS_FILE_PATTERNS = ['.agent.ts', '.agent.js', '.tool.ts', '.tool.js']

export function selectModel(phase: Phase, priorContextChars = 0): { model: ModelTier; score: number } {
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
    : ((phase as SerialPhase).project_context_files ?? [])

  const taskText = allTasks.join(' ').toLowerCase()
  const verifyText = allVerify.join(' ').toLowerCase()

  // Haiku signals (mechanical tasks pull score down)
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

  // Opus signals (AI/agent orchestration work)
  for (const kw of OPUS_KEYWORDS) {
    if (taskText.includes(kw)) score += 4
  }
  for (const pattern of OPUS_FILE_PATTERNS) {
    if (allFiles.some(f => f.endsWith(pattern))) score += 4
  }

  // Hard floor: 7+ tasks always warrant at least Sonnet
  if (allTasks.length >= 7) score = Math.max(score, 3)

  // Prior-phase context size: large prompts degrade Haiku quality more than Sonnet/Opus.
  // Any phase receiving meaningful prior context gets a minimum Sonnet floor.
  // Very large context (>25k chars) also boosts score toward Opus for complex phases.
  if (priorContextChars > 8_000) score = Math.max(score, 3)
  if (priorContextChars > 25_000) score += 3

  const model: ModelTier = score >= 8 ? 'powerful' : score >= 3 ? 'standard' : 'fast'
  return { model, score }
}
