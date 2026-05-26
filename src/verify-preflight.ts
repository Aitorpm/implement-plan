import { execFileSync } from 'child_process'

export function preflightVerifyCommands(commands: string[]): { ok: boolean; output: string } {
  const missing = [...new Set(commands
    .map(firstExternalCommand)
    .filter((cmd): cmd is string => Boolean(cmd))
    .filter(cmd => !commandExists(cmd))
  )]

  if (missing.length === 0) return { ok: true, output: '' }

  return {
    ok: false,
    output: `Missing executable${missing.length === 1 ? '' : 's'} in PATH: ${missing.join(', ')}`,
  }
}

export function isMissingCommandFailure(output: string): boolean {
  return /command not found|not found:|not recognized as an internal or external command/i.test(output)
}

function firstExternalCommand(command: string): string | null {
  const builtins = new Set([
    'alias', 'cd', 'command', 'echo', 'eval', 'export', 'false', 'pwd', 'set', 'shift',
    'test', 'true', 'type', 'ulimit', 'umask', 'unalias', 'unset', '[',
  ])

  const firstSegment = (command
    .trim()
    .split(/\s+(?:&&|\|\||;)\s+|(?:&&|\|\||;)/)[0] ?? '')
    .trim()
  const tokens = firstSegment.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g) ?? []

  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens.shift()
  }

  const executable = tokens[0]?.replace(/^['"]|['"]$/g, '')
  if (!executable || builtins.has(executable) || executable.includes('/')) return null
  return executable
}

function commandExists(command: string): boolean {
  try {
    execFileSync('sh', ['-lc', `command -v ${shellQuote(command)}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
