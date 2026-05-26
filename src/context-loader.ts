import * as fs from 'fs'
import * as path from 'path'

export function loadProjectDocs(workDir: string): string {
  const candidates = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', '.codex/AGENTS.md']
  const parts: string[] = []

  for (const candidate of candidates) {
    const fullPath = path.join(workDir, candidate)
    if (fs.existsSync(fullPath)) {
      parts.push(`## ${candidate}\n${fs.readFileSync(fullPath, 'utf-8').trim()}`)
    }
  }

  return parts.join('\n\n---\n\n')
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
