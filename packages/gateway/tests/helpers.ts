/** Test fakes: an in-memory effect ledger, a hand-built effective policy, a step token. */
import type { EffectClass, EffectLedger, LedgerState, StepToken, Treatment } from '@memwise/defs';
import type { EffectivePolicy, RuleOrigin } from '@memwise/policy';

export class MemoryLedger implements EffectLedger {
  rows = new Map<string, LedgerState>();
  log: string[] = [];

  async begin(key: string, entry: { tool: string }): Promise<LedgerState> {
    this.log.push(`begin ${key} ${entry.tool}`);
    const row = this.rows.get(key);
    if (row) return row;
    this.rows.set(key, { status: 'pending', startedAt: '2026-01-01T00:00:00.000Z' });
    return { status: 'new' };
  }
  async complete(key: string, result: unknown) {
    this.log.push(`complete ${key}`);
    this.rows.set(key, { status: 'done', result });
  }
  async fail(key: string, error: string) {
    this.log.push(`fail ${key}`);
    this.rows.set(key, { status: 'failed', error });
  }
}

const origin = (layer: RuleOrigin['layer'] = 'platform', name: string = layer): RuleOrigin => ({ layer, name });
const sourced = <T>(value: T, o = origin()) => ({ value, origin: o });

/** The platform defaults, written out by hand, with optional overrides. */
export function policy(over: {
  effects?: Partial<Record<EffectClass, Treatment>>;
  allowed?: string[];
  denied?: string[];
  perTool?: Record<string, Treatment>;
} = {}): EffectivePolicy {
  const effects: Record<EffectClass, Treatment> = {
    read: 'allow', draft: 'allow', write: 'allow', outbound: 'approve', irreversible: 'approve', ...over.effects,
  };
  return {
    effects: Object.fromEntries(Object.entries(effects).map(([k, v]) => [k, sourced(v)])) as EffectivePolicy['effects'],
    tools: {
      allowed: over.allowed ? sourced(over.allowed, origin('step', 'wf/step')) : null,
      denied: (over.denied ?? []).map((t) => sourced(t, origin('domain'))),
      required: [],
      perTool: Object.fromEntries(Object.entries(over.perTool ?? {}).map(([t, v]) => [t, { treatment: sourced(v, origin('workflow', 'wf')) }])),
    },
    budgets: {},
    modelRoles: null,
    taint: { enabled: sourced(true), outboundWhenTainted: sourced<Treatment>('approve') },
    layers: [{ kind: 'platform', name: 'platform' }],
  };
}

export const token: StepToken = {
  runId: 'run_1', caseId: 'case_1', stepId: 'check', stepRunId: 'run_1/1/check', workflowId: 'wf', workflowVersion: 1,
  agentRole: 'intake.check', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
};

export const call = (tool: string, args: unknown, key = `run_1/1/check:${tool}:1`) => ({
  tool, args, callId: 'call_1', idempotencyKey: key, token,
});
