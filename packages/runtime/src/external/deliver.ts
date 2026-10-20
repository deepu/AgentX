// Sending a message through the bound channel tool (23 §6, D69): `email.send` or `whatsapp.send`,
// whichever plugin provides it, through the tool gateway (ledger, idempotency, secrets), with one
// mw.deliveries row per idempotency key so a retry never sends twice.
import type { ChannelName, Delivery, StepToken } from '@memwise/defs';
import { ulid, type Queryable } from '@memwise/db';
import { resolveEffect, type GatewayDecision, type ToolGateway } from '@memwise/gateway';
import type { EffectivePolicy } from '@memwise/policy';
import type { Message } from './messages.ts';
import { compact } from './text.ts';

export const CHANNEL_TOOLS: Record<ChannelName, string> = { email: 'email.send', whatsapp: 'whatsapp.send' };

export interface DeliveryInput {
  message: Message;
  idemKey: string;
  purpose: Delivery['purpose'];
  token: StepToken;
  linkId?: string;
  caseId?: string;
  personId?: string;
  itemId?: string;
  /** "Send again": the person who confirmed the preview. */
  approvedBy?: string;
  /**
   * The policy the send is under (the step's, or the workspace's for a notification). A channel
   * tool it denies is not called, and its rate limit counts; an `approve` or `preview` verdict is
   * met by the approval already given (the invite, "Send again") or not asked (a notification).
   */
  policy?: EffectivePolicy;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export function deliveryOf(r: any): Delivery {
  return compact({
    id: r.id, channel: r.channel, to: r.to, purpose: r.purpose, linkId: r.link_id ?? undefined, personId: r.person_id ?? undefined,
    itemId: r.item_id ?? undefined, status: r.status, error: r.error ?? undefined, providerId: r.provider_id ?? undefined, at: iso(r.at),
  }) as Delivery;
}

/** The provider's message id in a channel tool's result, for status webhooks. */
function providerId(result: unknown): string | undefined {
  const r = result as { message_id?: unknown; id?: unknown; messageId?: unknown; messages?: { id?: unknown }[] } | null;
  const id = r?.message_id ?? r?.messageId ?? r?.id ?? r?.messages?.[0]?.id;
  return typeof id === 'string' ? id : undefined;
}

/** The channel tool bound for `via`, or why there is none. */
export function channelTool(tools: ToolGateway, via: ChannelName): string {
  const name = CHANNEL_TOOLS[via];
  if (!tools.get(name)) {
    throw new Error(`no ${via === 'email' ? 'email' : 'WhatsApp'} channel is connected: bind a plugin that provides ${name}`);
  }
  return name;
}

/**
 * Sends `message` once per `idemKey`: the delivery row is claimed first, the channel tool runs
 * through the gateway with the same key (so an idempotent provider dedupes a retried send), and
 * the row records the outcome. Throws when the send fails; the row says why.
 */
export async function deliver(db: Queryable, tools: ToolGateway, d: DeliveryInput): Promise<Delivery> {
  const { message } = d;
  const tool = channelTool(tools, message.via);
  await db.query(
    `insert into mw.deliveries (id, idem_key, channel, tool, "to", purpose, link_id, case_id, person_id, item_id, approved_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (idem_key) do nothing`,
    [`dlv_${ulid()}`, d.idemKey, message.via, tool, message.to, d.purpose, d.linkId ?? null, d.caseId ?? null, d.personId ?? null,
      d.itemId ?? null, d.approvedBy ?? null]);
  const args = message.via === 'email'
    ? { to: message.to, subject: message.subject ?? '', body: message.body }
    : message.template ? { to: message.to, template: message.template } : { to: message.to, body: message.body };
  const def = tools.get(tool)!;
  const { effect, classified } = resolveEffect(def, args);
  const checked = d.policy ? await tools.check({ tool, args, token: d.token }, d.policy, { tainted: false }) : undefined;
  // The message is the effect the person approved (the invite, "Send again") or a kernel
  // notification nobody approves (23 §6), so the channel call itself is not asked about again;
  // but a channel tool the policy denies is never called.
  const decision: GatewayDecision = checked?.decision.verdict === 'deny'
    ? checked
    : {
        tool, effect, classified,
        decision: { verdict: 'allow', reason: `${tool} delivers a message MemWise wrote (${d.purpose})`, origins: [] },
        ...(checked?.rateLimit ? { rateLimit: checked.rateLimit } : {}),
      };
  const r = await tools.execute({ tool, args, callId: d.idemKey, idempotencyKey: d.idemKey, token: d.token }, decision);
  const ok = r.status === 'ok';
  const error = r.status === 'ok' ? null : r.status === 'error' ? r.error : r.reason;
  const { rows } = await db.query(
    `update mw.deliveries set status = case when $2 and status in ('pending', 'failed') then 'sent' when $2 then status else 'failed' end,
            error = $3, provider_id = coalesce($4, provider_id), updated_at = now()
      where idem_key = $1 returning *`,
    [d.idemKey, ok, error, ok ? providerId(r.result) ?? null : null]);
  if (!ok) throw new Error(`the ${message.via === 'email' ? 'email' : 'WhatsApp message'} to ${message.to} was not sent: ${error}`);
  return deliveryOf(rows[0]);
}
