import * as fs from 'fs'
import * as path from 'path'

export function loadProjectDocs(workDir: string): string {
  const parts: string[] = []
  const packageManager = detectPackageManager(workDir)

  if (packageManager) {
    parts.push(
      `## Project Tooling\n` +
      `Detected package manager: ${packageManager}.\n` +
      `Use ${packageManager} commands in plan verify steps; do not use another package manager unless the project explicitly documents it.`
    )
  }

  // Primary context files — Claude reads CLAUDE.md, Codex reads AGENTS.md.
  // We inject both so the same prompt works regardless of which provider runs it.
  const primaryDocs = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.codex/AGENTS.md']
  for (const candidate of primaryDocs) {
    const fullPath = path.join(workDir, candidate)
    if (fs.existsSync(fullPath)) {
      parts.push(`## ${candidate}\n${fs.readFileSync(fullPath, 'utf-8').trim()}`)
    }
  }

  // Project-local skills / slash commands (.claude/commands/*.md in the workDir).
  // Claude Code agents use --bare, which skips auto-discovery of these files, so we
  // inject them manually. Codex has no equivalent mechanism and also needs them injected.
  const commandsDir = path.join(workDir, '.claude', 'commands')
  if (fs.existsSync(commandsDir)) {
    try {
      const skillFiles = fs.readdirSync(commandsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
      for (const file of skillFiles) {
        const fullPath = path.join(commandsDir, file)
        const content = fs.readFileSync(fullPath, 'utf-8').trim()
        if (content) {
          parts.push(`## Project Skill: ${file}\n${content}`)
        }
      }
    } catch {
      // Directory not readable — skip.
    }
  }

  return parts.join('\n\n---\n\n')
}

export function detectPackageManager(workDir: string): string | null {
  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ]

  for (const [file, manager] of lockfiles) {
    if (fs.existsSync(path.join(workDir, file))) return manager
  }

  const packageJson = path.join(workDir, 'package.json')
  if (!fs.existsSync(packageJson)) return null

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'))
    const declared = typeof pkg.packageManager === 'string'
      ? pkg.packageManager.split('@')[0]
      : ''
    if (['pnpm', 'yarn', 'bun', 'npm'].includes(declared)) return declared
    return 'npm'
  } catch {
    return 'npm'
  }
}

export function loadPhaseFiles(workDir: string, filePaths: string[]): string {
  const parts: string[] = []

  for (const filePath of filePaths) {
    const fullPath = path.join(workDir, filePath)
    if (!fs.existsSync(fullPath)) continue

    const content = fs.readFileSync(fullPath, 'utf-8')
    const lines = content.split('\n')
    const truncated = lines.slice(0, 100).join('\n')
    const suffix = lines.length > 100 ? `\n... (${lines.length - 100} more lines)` : ''

    parts.push(`### ${filePath}\n\`\`\`\n${truncated}${suffix}\n\`\`\``)
  }

  return parts.join('\n\n')
}

const PRIOR_PHASE_PRIORITY: RegExp[] = [
  /\.prisma$/,
  /constants\.[tj]sx?$/,
  /types\.[tj]sx?$/,
  /\.module\.[tj]sx?$/,
  /schema\.[tj]sx?$/,
  /enums?\.[tj]sx?$/,
]

function priorFilePriority(file: string): number {
  for (let i = 0; i < PRIOR_PHASE_PRIORITY.length; i++) {
    if (PRIOR_PHASE_PRIORITY[i].test(file)) return PRIOR_PHASE_PRIORITY.length - i
  }
  return 0
}

export function loadPriorPhaseFiles(workDir: string, files: string[]): string {
  const MAX_FILES = 10
  const MAX_LINES = 200
  const MAX_TOTAL_CHARS = 40_000

  const sorted = [...new Set(files)]
    .filter(f => !f.startsWith('.worktrees/') && f !== '.phase-complete.json')
    .sort((a, b) => priorFilePriority(b) - priorFilePriority(a))
    .slice(0, MAX_FILES)

  const parts: string[] = []
  let totalChars = 0

  for (const filePath of sorted) {
    if (totalChars >= MAX_TOTAL_CHARS) break

    const fullPath = path.join(workDir, filePath)
    if (!fs.existsSync(fullPath)) continue

    const content = fs.readFileSync(fullPath, 'utf-8')
    const lines = content.split('\n')
    const truncated = lines.slice(0, MAX_LINES).join('\n')
    const suffix = lines.length > MAX_LINES
      ? `\n... (${lines.length - MAX_LINES} more lines — read the full file if needed)`
      : ''

    const block = `### ${filePath}\n\`\`\`\n${truncated}${suffix}\n\`\`\``
    totalChars += block.length
    parts.push(block)
  }

  return parts.join('\n\n')
}
