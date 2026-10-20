// Change notifications (19 §8): one dedicated connection LISTENs on `mw_changes` (the triggers
// in migration 0002) and fans each payload out to the kernel's listeners. The connection is
// opened with the first listener and reopened after an error, with a growing delay.
import pg from 'pg';
import type { KernelChange } from './types.ts';

export const CHANGES_CHANNEL = 'mw_changes';

export class ChangeFeed {
  private listeners = new Set<(c: KernelChange) => void>();
  private client?: pg.Client;
  private connecting?: Promise<void>;
  private closed = false;
  private retryMs = 250;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly url: string) {}

  subscribe(listener: (c: KernelChange) => void): () => void {
    this.listeners.add(listener);
    void this.ensure();
    return () => { this.listeners.delete(listener); };
  }

  /** For changes the kernel makes without a trigger (definitions re-indexed). */
  emit(change: KernelChange): void {
    for (const l of this.listeners) {
      try { l(change); } catch { /* a listener's failure is its own */ }
    }
  }

  /** Resolves once the LISTEN is in place (tests wait on it). */
  ready(): Promise<void> {
    return this.connecting ?? this.ensure();
  }

  private ensure(): Promise<void> {
    if (this.closed || this.client) return Promise.resolve();
    return (this.connecting ??= this.connect().finally(() => { this.connecting = undefined; }));
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.url, application_name: 'memwise-changes' });
    const retry = () => {
      if (this.client === client) this.client = undefined;
      client.removeAllListeners();
      client.on('error', () => {});
      void client.end().catch(() => {});
      if (this.closed || !this.listeners.size) return;
      this.timer = setTimeout(() => { void this.ensure(); }, this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
    client.on('error', retry);
    client.on('end', () => { if (this.client === client) retry(); });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANGES_CHANNEL || !msg.payload) return;
      let change: KernelChange;
      try { change = JSON.parse(msg.payload); } catch { return; }
      this.emit(change);
    });
    try {
      await client.connect();
      await client.query(`listen ${CHANGES_CHANNEL}`);
      if (this.closed) { await client.end().catch(() => {}); return; }
      this.client = client;
      this.retryMs = 250;
    } catch {
      retry();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.connecting?.catch(() => {});
    const c = this.client;
    this.client = undefined;
    if (c) { c.removeAllListeners(); c.on('error', () => {}); await c.end().catch(() => {}); }
    this.listeners.clear();
  }
}
