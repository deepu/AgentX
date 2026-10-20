/**
 * The public handler's own limits (23 §3-4): a per-IP request counter as a second line behind the
 * relay's and the kernel's per-link limits, and request bodies read as a stream with a cap, so a
 * large body is refused without holding it all.
 */

/** Uploads: one file of at most 15 MiB (23 §3). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
/** JSON bodies (drafts, extraction, submissions, decisions). */
export const MAX_JSON_BYTES = 256 * 1024
/** Webhook bodies (status updates and messages are small). */
export const MAX_WEBHOOK_BYTES = 1024 * 1024

export class BodyTooLarge extends Error {
  constructor(readonly limit: number) { super(`body over ${limit} bytes`) }
}

/** Reads the whole body, refusing (BodyTooLarge) as soon as it passes `limit`. */
export async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge(limit)
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        throw new BodyTooLarge(limit)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

export interface IpLimit { count: number; perMs: number }

/**
 * Counts requests per client IP in fixed windows. In memory and per process: the relay and the
 * kernel enforce the limits that matter; this keeps one address from flooding the core.
 */
export class IpRateLimiter {
  private readonly windows = new Map<string, { start: number; used: number }>()

  constructor(private readonly limit: IpLimit, private readonly now: () => number = Date.now) {}

  /** Counts one request; false when this address is over its limit for the current window. */
  take(ip: string): boolean {
    const t = this.now()
    if (this.windows.size > 10_000) this.sweep(t)
    const w = this.windows.get(ip)
    if (!w || t - w.start >= this.limit.perMs) {
      this.windows.set(ip, { start: t, used: 1 })
      return true
    }
    if (w.used >= this.limit.count) return false
    w.used++
    return true
  }

  private sweep(t: number): void {
    for (const [ip, w] of this.windows) if (t - w.start >= this.limit.perMs) this.windows.delete(ip)
  }
}
