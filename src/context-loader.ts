import * as fs from 'fs'
import * as path from 'path'

export function loadProjectDocs(workDir: string): string {
  const candidates = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.codex/AGENTS.md']
  const parts: string[] = []
  const packageManager = detectPackageManager(workDir)

  if (packageManager) {
    parts.push(
      `## Project Tooling\n` +
      `Detected package manager: ${packageManager}.\n` +
      `Use ${packageManager} commands in plan verify steps; do not use another package manager unless the project explicitly documents it.`
    )
  }

  for (const candidate of candidates) {
    const fullPath = path.join(workDir, candidate)
    if (fs.existsSync(fullPath)) {
      parts.push(`## ${candidate}\n${fs.readFileSync(fullPath, 'utf-8').trim()}`)
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
