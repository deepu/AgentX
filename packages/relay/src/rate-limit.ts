// Fixed-window request counters, kept in memory by whichever host runs the relay.

/** Requests per key in fixed windows; forgets old keys as it goes. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one request; returns 0 when allowed, else the seconds until the window resets. */
  take(key: string): number {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.prune(now);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
    w.count++;
    return 0;
  }

  private prune(now: number) {
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}
