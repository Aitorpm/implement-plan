import { Phase, SerialPhase, ParallelPhase } from './plan-parser'
import { ModelTier } from './providers/types'

export type ProviderPreference = 'codex' | 'claude' | null
// null = no strong signal; registry uses its natural order

// Codex strengths: terminal-native, mechanical, high file-throughput tasks
// Source: 82.7% Terminal-Bench (vs Claude 69.4%)
const CODEX_KEYWORDS = [
  'bash', 'shell', 'script', 'run command', 'run migration',
  'git ', 'migrate', 'scaffold', 'generate ',
  'create a file', 'create src/', 'create the file',
  'rename ', 'move file', 'copy file', 'chmod', 'install dependency',
  'add import', 'barrel export', 'constant',
]

// Claude strengths: reasoning, business logic, design decisions
// Source: 64.3% SWE-bench Pro (vs Codex 58.6%)
const CLAUDE_KEYWORDS = [
  'implement', 'refactor', 'optimize', 'redesign', 'algorithm',
  'edge case', 'state machine', 'middleware', 'service', 'architecture',
  'interface', 'type guard', 'handle error', 'calculate', 'pure function',
]

const TEST_SUITE_PATTERNS = ['vitest', 'jest', 'pytest', 'go test', 'pnpm test', 'npm test']

export function selectProvider(
  phase: Phase,
  resolvedTier?: ModelTier,
): { provider: ProviderPreference; score: number } {
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

  const taskText = allTasks.join(' ').toLowerCase()
  const verifyText = allVerify.join(' ').toLowerCase()

  // Codex signals
  for (const kw of CODEX_KEYWORDS) {
    if (taskText.includes(kw)) score += 2
  }

  // Claude signals
  for (const kw of CLAUDE_KEYWORDS) {
    if (taskText.includes(kw)) score -= 2
  }

  // Test suites require understanding business logic → Claude
  if (TEST_SUITE_PATTERNS.some(p => verifyText.includes(p))) score -= 2

  // Model tier as weak corroborating signal
  if (resolvedTier === 'fast') score += 1       // mechanical → Codex
  if (resolvedTier === 'standard' || resolvedTier === 'powerful') score -= 1  // reasoning → Claude

  const provider: ProviderPreference =
    score >= 3 ? 'codex' :
    score <= -3 ? 'claude' :
    null

  return { provider, score }
}
