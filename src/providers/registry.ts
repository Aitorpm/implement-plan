import { Provider } from './types'

export class ProviderRegistry {
  // Per-phase rate limits — cleared at the start of each phase
  private rateLimitedThisPhase = new Set<string>()
  // Session-wide cooldowns — only when both providers are exhausted simultaneously
  private rateLimitedUntil = new Map<string, Date>()

  constructor(
    public readonly providers: Provider[],
    private readonly cooldownMs = 60 * 60 * 1000,
  ) {}

  getAvailable(preferred?: string): Provider | null {
    const now = new Date()
    const candidates = preferred
      ? [
          ...this.providers.filter(p => p.name === preferred),
          ...this.providers.filter(p => p.name !== preferred),
        ]
      : this.providers

    for (const p of candidates) {
      if (this.rateLimitedThisPhase.has(p.name)) continue
      const until = this.rateLimitedUntil.get(p.name)
      if (until && until > now) continue
      return p
    }
    return null
  }

  markRateLimitedForPhase(name: string): void {
    this.rateLimitedThisPhase.add(name)
  }

  nextPhase(): void {
    this.rateLimitedThisPhase.clear()
  }

  markRateLimitedSession(name: string): void {
    this.rateLimitedUntil.set(name, new Date(Date.now() + this.cooldownMs))
  }

  allRateLimited(): boolean {
    return this.getAvailable() === null
  }

  nextAvailableAt(): Date | null {
    if (!this.allRateLimited()) return null
    const dates = this.providers.map(p => this.rateLimitedUntil.get(p.name)).filter(Boolean) as Date[]
    if (dates.length === 0) return null
    return new Date(Math.min(...dates.map(d => d.getTime())))
  }

  async waitForAvailable(abortSignal: AbortSignal): Promise<void> {
    const POLL_MS = 5 * 60 * 1000

    while (this.allRateLimited()) {
      if (abortSignal.aborted) return

      // Mark all current phase-limited providers as session-limited for the wait
      for (const p of this.providers) {
        if (this.rateLimitedThisPhase.has(p.name) && !this.rateLimitedUntil.has(p.name)) {
          this.markRateLimitedSession(p.name)
        }
      }
      this.rateLimitedThisPhase.clear()

      const next = this.nextAvailableAt()
      if (next) {
        const mins = Math.ceil((next.getTime() - Date.now()) / 60000)
        const hhmm = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        process.stdout.write(`\n⏳ Both providers rate-limited. Resuming at ${hhmm} (~${mins} min)`)
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS)
        abortSignal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })

      if (!this.allRateLimited()) {
        process.stdout.write(' ✓\n')
      } else {
        process.stdout.write('.')
      }
    }
  }
}
