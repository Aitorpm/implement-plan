import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChildProcess } from 'child_process'
import { resolveGenerateInput } from '../src/cli-input'
import { detectPackageManager, loadProjectDocs } from '../src/context-loader'
import { generatePlan } from '../src/plan-generator'
import { validatePlan } from '../src/plan-validator'
import { Provider, ProviderProgress, ProviderResult } from '../src/providers/types'
import { ProviderRegistry } from '../src/providers/registry'

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'implement-plan-test-'))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

class FakeProcess extends EventEmitter {
  kill(): boolean {
    this.emit('close', 0)
    return true
  }
}

class FakeProvider implements Provider {
  readonly modelMap = {
    fast: 'fake-fast',
    standard: 'fake-standard',
    powerful: 'fake-powerful',
  }
  calls = 0

  constructor(
    readonly name: string,
    private readonly result: ProviderResult,
  ) {}

  isInstalled(): boolean {
    return true
  }

  spawn(): ChildProcess {
    return new FakeProcess() as ChildProcess
  }

  async parseStream(_proc: ChildProcess, _prefix: string, _workDir: string, onProgress?: ProviderProgress): Promise<ProviderResult> {
    this.calls += 1
    onProgress?.(`${this.name} progress`)
    return this.result
  }

  detectRateLimit(): boolean {
    return this.result.rateLimited
  }
}

test('generate input accepts a file path and uses the file basename as slug seed', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'quotes-backend-plan.md')
    writeFileSync(file, 'Natural language plan body', 'utf-8')

    const input = resolveGenerateInput(file, dir)

    assert.equal(input.description, 'Natural language plan body')
    assert.equal(input.slugSeed, 'quotes-backend-plan')
    assert.equal(input.source, file)
  } finally {
    cleanup(dir)
  }
})

test('project docs include detected npm package manager from lockfile', () => {
  const dir = tempDir()
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"build":"tsc"}}', 'utf-8')
    writeFileSync(path.join(dir, 'package-lock.json'), '{}', 'utf-8')

    assert.equal(detectPackageManager(dir), 'npm')
    const docs = loadProjectDocs(dir)
    assert.match(docs, /Detected package manager: npm/)
    assert.doesNotMatch(docs, /Detected package manager: pnpm/)
  } finally {
    cleanup(dir)
  }
})

test('plan generation falls back from rate-limited provider to next provider', async () => {
  const dir = tempDir()
  const claude = new FakeProvider('claude', {
    success: false,
    rateLimited: true,
    costUsd: 0,
    numTurns: 0,
    hasCompletionFile: false,
    filesWritten: [],
    assistantText: "You've hit your session limit",
    error: 'session limit',
  })
  const codex = new FakeProvider('codex', {
    success: true,
    rateLimited: false,
    costUsd: 0,
    numTurns: 1,
    hasCompletionFile: false,
    filesWritten: [],
    assistantText: '# Plan\n\nGenerated plan\n\nphases:\n  - id: 1\n    name: "Test"\n    mode: serial\n    tasks:\n      - Do it\n    verify:\n      - "node --version"',
  })

  const originalWrite = process.stdout.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    const result = await generatePlan('build something', dir, new ProviderRegistry([claude, codex]))

    assert.equal(claude.calls, 1)
    assert.equal(codex.calls, 1)
    assert.match(result, /^# Plan/)
  } finally {
    process.stdout.write = originalWrite
    cleanup(dir)
  }
})

test('plan validation fails before execution when verify executable is missing', () => {
  const dir = tempDir()
  try {
    const planPath = path.join(dir, 'plan.md')
    writeFileSync(planPath, `# Bad Verify

Test plan.

phases:
  - id: 1
    name: "Uses missing tool"
    mode: serial
    tasks:
      - Touch a file
    verify:
      - "definitely-not-a-real-command-xyz --version"
`, 'utf-8')

    const originalLog = console.log
    let result: ReturnType<typeof validatePlan>
    try {
      console.log = () => {}
      result = validatePlan(planPath, dir)
    } finally {
      console.log = originalLog
    }

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /Missing executable in PATH: definitely-not-a-real-command-xyz/)
  } finally {
    cleanup(dir)
  }
})
