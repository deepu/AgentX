// kernel.external (23 §3-6, D67-D69): links to external steps, the public form behind them,
// extraction in the form, `external.invite`, and inbox links. Every public call takes the raw
// token and answers a plain refusal for a bad one; nothing here throws at a participant.
import { isDeepStrictEqual } from 'node:util';
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import {
  parseDuration, type ApprovalDecision, type CaseValue, type ChannelName, type Delivery, type ExternalComment, type ExternalDocument,
  type ExternalLinkSummary, type ExternalParticipant, type ExternalSubmitInput, type ExternalSubmitResult, type ExtractResult,
  type InboxLinkAnswer, type InboxLinkDecision, type InboxLinkItem, type InboxLinkResult, type LinkRefusal, type Provenance,
  type RecordTypes, type StepDef, type StepToken, type WorkflowDef,
} from '@memwise/defs';
import { withTransaction, type PgFileStore, type PgPeopleStore, type PgRateCounter, type Queryable } from '@memwise/db';
import type { ToolDefinition, ToolGateway } from '@memwise/gateway';
import type pg from 'pg';
import { returnedComments } from '../prepare.ts';
import { answerErrors, cleanValues, closeStepLinks, lockWaitingStep, queueSubmission } from '../submit.ts';
import { EXTERNAL_INVITE_TOOL, type Actor, type DocumentValue, type ExternalService, type InboxItem, type PersonActor, type PublicRequestInfo, type SubmitResult, type SubmitStepInput } from '../types.ts';
import { maySee, type DefinitionCache } from '../views.ts';
import { channelTool, deliver } from './deliver.ts';
import { componentToken, keptProvenance, runExtraction } from './extraction.ts';
import { ACCEPTED_TYPES, buildForm, formDocument, formSuggestion, MAX_FILE_BYTES, MAX_FILES, sniffType } from './form.ts';
import {
  expiryMs, INBOX_LINK_MS, insertLink, kernelKey, linkById, linkByToken, linkStatus, linkSummary, randomLinkKey, refusal, tokenOf,
  type LinkRow, type StoredSuggestion,
} from './links.ts';
import { inviteMessage, maskedLink, type Message } from './messages.ts';
import { businessName, compact, firstName, participantLabel, plainLabel } from './text.ts';

/** Per link (23 §3): requests a minute, extraction calls and submission attempts an hour. */
export const LINK_LIMITS = {
  request: { count: 60, perMs: 60_000 },
  extract: { count: 10, perMs: 3600_000 },
  submit: { count: 20, perMs: 3600_000 },
} as const;
const DRAFT_MAX_BYTES = 256 * 1024;

export const NO_PUBLIC_ADDRESS = 'connect a public address in Settings → Public address, so the link can be opened from outside';

export interface ExternalDeps {
  pool: pg.Pool;
  defs: DefinitionCache;
  client: DBOSClient;
  tools: () => ToolGateway;
  files: PgFileStore;
  people: PgPeopleStore;
  rates: PgRateCounter;
  entities: () => RecordTypes;
  publicUrl: () => string | undefined;
  businessName?: string | (() => string | undefined);
  inbox: (actor: Actor) => Promise<InboxItem[]>;
  submitStep: (input: SubmitStepInput, opts: { channel?: string }) => Promise<SubmitResult>;
  decideApproval: (decision: ApprovalDecision, by: Actor) => Promise<{ applied: boolean; status: string }>;
  /**
   * The workflow as loaded from its files, when that is the version asked for: the stored one
   * comes back from jsonb with its keys reordered, and the form lists fields in the file's order.
   */
  sourceWorkflow?: (id: string, hash: string) => WorkflowDef | undefined;
}

interface RunInfo { id: string; case_id: string; state: string; status: string; entered_seq: number; workflow_id: string; workflow_hash: string }

/** The step link's current waiting step run, or why there is none. */
type Resolved = { run: RunInfo; workflow: WorkflowDef; step: StepDef; stepRunId: string };

export interface ExternalKernelService extends ExternalService {
  /** The `external.invite` kernel tool (23 §3). */
  inviteTool: ToolDefinition<InviteArgs, InviteResult>;
  /** Provenance of values staff kept as their extraction suggested (submitStep with `sources`). */
  sourcedProvenance(db: pg.PoolClient, stepRunId: string, values: Record<string, unknown>, sources: Record<string, string>, by: string): Promise<Record<string, Provenance>>;
  /** Issues an inbox link for one person and one item (notifications, 23 §6). */
  issueInboxLink(input: { personId: string; item: InboxItem; via: ChannelName; idemKey?: string }): Promise<{ link: ExternalLinkSummary; url: string; title: string } | undefined>;
  /** What an inbox item is called in a message or on its link page. */
  itemTitle(item: InboxItem): Promise<string>;
  publicBase(): string | undefined;
}

export interface InviteArgs {
  step: string; name?: string; email?: string; phone?: string; via: ChannelName; note?: string; expires_in?: string | number;
}
export interface InviteResult { link_id: string; sent: true; via: ChannelName; expires_at: string }

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isDocType = (t: import('@memwise/defs').ValueType): boolean =>
  (t.kind === 'scalar' && (t.name === 'Document' || t.name === 'File' || t.name === 'Image')) || (t.kind === 'list' && isDocType(t.of));

/**
 * What `external.invite` is, without a kernel to run it: its name, schema and class. `memwise
 * check` and example cases bind it by this; the kernel's own adds the behaviour.
 */
export function externalInviteShape(): Omit<ToolDefinition<InviteArgs, InviteResult>, 'execute'> {
  return {
    name: EXTERNAL_INVITE_TOOL,
    description: 'Send someone outside the business a single-use link to an external step\'s form, by email or WhatsApp. The message is a fixed template; its preview is the exact text.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'The external step the link opens' },
        name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
        via: { type: 'string', enum: ['email', 'whatsapp'] },
        note: { type: 'string', description: 'What the person is asked to do or fix, shown with the form' },
        expires_in: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'e.g. 7d; default the step\'s timeout, else 7 days; at most 30 days' },
      },
      required: ['step', 'via'],
      additionalProperties: false,
    },
    effect: 'outbound',
    idempotent: true,
    source: { plugin: 'memwise' },
  };
}

export function createExternalService(deps: ExternalDeps): ExternalKernelService {
  const { pool, defs } = deps;
  const business = () => businessName(pool, deps.businessName);
  const linksKey = () => kernelKey(pool, 'links');
  const publicBase = () => deps.publicUrl()?.replace(/\/+$/, '') || undefined;
  const workflowOf = async (id: string, hash: string) => deps.sourceWorkflow?.(id, hash) ?? defs.workflow(id, hash);

  async function runInfo(db: Queryable, runId: string): Promise<RunInfo | undefined> {
    const { rows } = await db.query(
      `select id, case_id, state, status, entered_seq, workflow_id, workflow_hash from mw.runs where id = $1`, [runId]);
    return rows[0];
  }

  /** Whether a person may act on links to `stepId`: its assignee's role, or the workflow owner's. */
  function mayManage(by: PersonActor, workflow: WorkflowDef, stepId: string): string | undefined {
    const roles = [...new Set([workflow.steps[stepId]?.assignee, workflow.owner].filter((r): r is string => !!r))];
    if (!roles.length || roles.some((r) => by.roles.includes(r))) return undefined;
    return `only someone with the ${roles.join(' or ')} role can do this`;
  }

  async function resolve(db: Queryable, link: LinkRow): Promise<Resolved | LinkRefusal['status']> {
    const run = await runInfo(db, link.run_id);
    if (!run || run.status !== 'active' || !link.step_id) return 'closed';
    const workflow = await workflowOf(run.workflow_id, run.workflow_hash);
    const step = workflow.steps[link.step_id];
    if (!step || step.performer !== 'external') return 'closed';
    if (run.state !== link.step_id) return link.step_run_id ? 'closed' : 'not_yet';
    const stepRunId = `${run.id}/${run.entered_seq}/${run.state}`;
    if (link.step_run_id && link.step_run_id !== stepRunId) return 'closed';
    const sr = await db.query(`select status from mw.step_runs where id = $1`, [stepRunId]);
    if (!sr.rows[0]) return 'not_yet';
    if (sr.rows[0].status !== 'waiting') return 'closed';
    return { run, workflow, step, stepRunId };
  }

  /** The open link for a public call, counted against its limits; or the refusal to answer. */
  async function open(token: string, kind: 'step' | 'inbox', limit?: keyof typeof LINK_LIMITS): Promise<LinkRow | LinkRefusal> {
    const link = await linkByToken(pool, token).catch(() => undefined);
    if (!link || link.kind !== kind) return refusal('unknown', await business());
    const status = linkStatus(link);
    if (status !== 'open') return refusal(status, await business());
    for (const which of ['request', ...(limit && limit !== 'request' ? [limit] : [])] as (keyof typeof LINK_LIMITS)[]) {
      const r = await deps.rates.take(`external.link.${which}`, link.id, LINK_LIMITS[which]);
      if (!r.allowed) return refusal('rate_limited', await business());
    }
    return link;
  }

  /** `open` and `resolve` for a step link, binding it to the step run it opens. */
  async function openStep(token: string, limit?: keyof typeof LINK_LIMITS): Promise<{ link: LinkRow; at: Resolved } | LinkRefusal> {
    const link = await open(token, 'step', limit);
    if ('message' in link) return link;
    const at = await resolve(pool, link);
    if (typeof at === 'string') return refusal(at, await business());
    if (!link.step_run_id) {
      await pool.query(`update mw.external_links set step_run_id = $2 where id = $1 and step_run_id is null`, [link.id, at.stepRunId]);
      link.step_run_id = at.stepRunId;
    }
    return { link, at };
  }

  async function caseValues(db: Queryable, caseId: string): Promise<Record<string, CaseValue>> {
    const { rows } = await db.query(`select values from mw.cases where id = $1`, [caseId]);
    return rows[0]?.values ?? {};
  }

  /** Comments returned to this step (first names only), and the link's note. */
  async function formComments(link: LinkRow, stepRunId: string): Promise<ExternalComment[]> {
    const out: ExternalComment[] = (await returnedComments(pool, stepRunId)).map((c) => ({
      from: c.by && c.who !== c.by ? firstName(c.who) : 'MemWise', text: c.comment, at: c.at,
    }));
    if (link.note) {
      let from = 'MemWise';
      if (link.created_by && !link.created_by.startsWith('step:')) from = firstName((await deps.people.get(link.created_by))?.name) || from;
      out.push({ from, text: link.note, at: iso(link.created_at) });
    }
    return out;
  }

  /** Document values a participant may submit for a field: files sent through this link, or already on the case. */
  async function documentValues(db: Queryable, link: LinkRow, value: unknown, current: unknown): Promise<{ docs: DocumentValue[]; bad: boolean }> {
    const onCase = (Array.isArray(current) ? current : current ? [current] : []) as DocumentValue[];
    const allowed = new Set([...(link.files ?? []), ...onCase.map((d) => d?.id).filter(Boolean)]);
    const docs: DocumentValue[] = [];
    let bad = false;
    for (const ref of Array.isArray(value) ? value : [value]) {
      const id = typeof ref === 'string' ? ref : (ref as ExternalDocument | undefined)?.id;
      if (!id || !allowed.has(id)) { bad = true; continue; }
      const meta = await deps.files.meta(db, id);
      if (meta) docs.push(meta); else bad = true;
    }
    return { docs, bad };
  }

  async function stepPolicy(workflow: WorkflowDef, stepId: string) {
    return (await defs.policy(workflow, stepId)).effective;
  }

  async function caseTitle(workflow: WorkflowDef, caseId: string): Promise<string> {
    const values = await caseValues(pool, caseId);
    const fields = workflow.caseType.fields;
    const name = Object.keys(fields).find((k) => fields[k]!.type.kind === 'scalar' && (fields[k]!.type as { name: string }).name === 'PersonName' && typeof values[k]?.value === 'string');
    return name ? `${workflow.title ?? plainLabel(workflow.id)} for ${values[name]!.value as string}` : (workflow.title ?? plainLabel(workflow.id));
  }

  async function stateTimeout(workflow: WorkflowDef, stepId: string) {
    return workflow.states[stepId]?.wait?.timeout?.afterMs;
  }

  // ---------------------------------------------------------------- external.invite (23 §3)

  async function inviteParts(args: InviteArgs, runId: string) {
    const run = await runInfo(pool, runId);
    if (!run) throw new Error(`no run ${runId}`);
    const workflow = await workflowOf(run.workflow_id, run.workflow_hash);
    const target = workflow.steps[args.step];
    if (!target || target.performer !== 'external') throw new Error(`${args.step} is not a step for someone outside the business in ${workflow.id}`);
    const to = args.via === 'email' ? args.email?.trim() : args.phone?.trim();
    if (!to) throw new Error(`the case has no ${args.via === 'email' ? 'email address' : 'phone number'} for ${args.name?.trim() || 'the client'}, so the link can't be sent by ${args.via}`);
    const requested = args.expires_in !== undefined ? parseDuration(args.expires_in) : undefined;
    const expires = expiryMs(requested, await stateTimeout(workflow, args.step));
    const note = args.note?.trim() || undefined;
    const text = { business: await business(), name: args.name, purpose: workflow.title ?? plainLabel(workflow.id), form: target.title, note };
    return { run, workflow, target, to, expires, note, text };
  }

  const inviteTool: ToolDefinition<InviteArgs, InviteResult> = {
    ...externalInviteShape(),
    unavailable: () => (publicBase() ? undefined : NO_PUBLIC_ADDRESS),
    async preview(args, ctx) {
      if (!ctx?.token) return { summary: `Send a link to ${args.step} by ${args.via}`, detail: args };
      const p = await inviteParts(args, ctx.token.runId);
      const m = inviteMessage(args.via, p.to, { ...p.text, url: maskedLink(publicBase() ?? 'https://…', 'f'), expiresAt: new Date(Date.now() + p.expires) });
      const what = args.via === 'email' ? `Email to ${p.to}: ${m.subject}` : `WhatsApp message to ${p.to}`;
      return { summary: `${what} (a link to "${p.target.title}")`, detail: compact({ to: m.to, via: m.via, subject: m.subject, body: m.body, template: m.template }) };
    },
    async execute(args, ctx) {
      const base = publicBase();
      if (!base) throw new Error(NO_PUBLIC_ADDRESS);
      const p = await inviteParts(args, ctx.token.runId);
      channelTool(deps.tools(), args.via);
      // Once per call: a retry with the same key gets the same link (and token) back.
      const { row, token } = await insertLink(pool, await linksKey(), {
        kind: 'step', idemKey: `invite:${ctx.idempotencyKey}`, runId: p.run.id, caseId: p.run.case_id, stepId: args.step,
        participant: compact({ name: args.name?.trim(), email: args.email?.trim(), phone: args.phone?.trim() }), via: args.via, note: p.note,
        createdBy: `step:${ctx.token.stepRunId}`, expiresInMs: p.expires,
      });
      const status = linkStatus(row);
      if (status !== 'open') throw new Error(`the link for this invite is ${status}; send a new one`);
      const message = inviteMessage(args.via, p.to, { ...p.text, url: `${base}/f/${token}`, expiresAt: row.expires_at });
      await deliver(pool, deps.tools(), {
        message, idemKey: `${ctx.idempotencyKey}:send`, purpose: 'invite', token: ctx.token, linkId: row.id, caseId: p.run.case_id,
      });
      await pool.query(`update mw.external_links set sent_at = coalesce(sent_at, now()) where id = $1`, [row.id]);
      return { link_id: row.id, sent: true, via: args.via, expires_at: iso(row.expires_at) };
    },
  };

  // ---------------------------------------------------------------- staff: issue, revoke, resend

  async function resendParts(link: LinkRow, via?: ChannelName): Promise<{ message: Message; base: string } | { message: string }> {
    if (link.kind !== 'step' || linkStatus(link) !== 'open') return { message: `This link is ${linkStatus(link)}; issue a new one instead.` };
    const base = publicBase();
    if (!base) return { message: `To send a link, ${NO_PUBLIC_ADDRESS}.` };
    const channel: ChannelName | undefined = via ?? (link.via === 'email' || link.via === 'whatsapp' ? link.via
      : link.participant.email ? 'email' : link.participant.phone ? 'whatsapp' : undefined);
    if (!channel) return { message: 'This link has no email address or phone number to send it to.' };
    const to = channel === 'email' ? link.participant.email : link.participant.phone;
    if (!to) return { message: `There is no ${channel === 'email' ? 'email address' : 'phone number'} for ${participantLabel(link.participant)}.` };
    const run = await runInfo(pool, link.run_id);
    const workflow = await workflowOf(run!.workflow_id, run!.workflow_hash);
    const step = workflow.steps[link.step_id!]!;
    const token = tokenOf(await linksKey(), link)!;
    return {
      base,
      message: inviteMessage(channel, to, {
        business: await business(), name: link.participant.name, purpose: workflow.title ?? plainLabel(workflow.id), form: step.title,
        url: `${base}/f/${token}`, expiresAt: link.expires_at, ...(link.note ? { note: link.note } : {}),
      }),
    };
  }

  async function managed(linkId: string, by: PersonActor): Promise<{ link: LinkRow; workflow: WorkflowDef } | { message: string }> {
    const link = await linkById(pool, linkId);
    if (!link || link.kind !== 'step') return { message: `no link ${linkId}` };
    const run = await runInfo(pool, link.run_id);
    if (!run) return { message: `no run ${link.run_id}` };
    const workflow = await workflowOf(run.workflow_id, run.workflow_hash);
    const forbidden = mayManage(by, workflow, link.step_id!);
    return forbidden ? { message: forbidden } : { link, workflow };
  }

  // ---------------------------------------------------------------- inbox links (23 §6)

  async function itemTitle(item: InboxItem): Promise<string> {
    if (item.kind === 'identity') return 'Confirm a record match';
    const wf = await defs.latest(item.workflowId);
    const run = await runInfo(pool, item.runId);
    const workflow = run ? await workflowOf(run.workflow_id, run.workflow_hash) : wf;
    const cTitle = workflow ? await caseTitle(workflow, item.caseId) : item.caseId;
    switch (item.kind) {
      case 'approval': return `approve ${item.approval.preview.summary} (${cTitle})`;
      case 'attention': return `${cTitle} needs someone (${item.reason})`;
      case 'reminder': return item.text;
      default: return `${workflow?.steps[item.stepId]?.title ?? plainLabel(item.stepId)} (${cTitle})`;
    }
  }

  /** The item of an inbox link as its person may see it now, or why not. */
  async function inboxLinkItem(link: LinkRow): Promise<{ actor: PersonActor; item: InboxItem; name: string } | { status: 'forbidden' | 'closed'; message: string }> {
    const person = link.person_id ? await deps.people.get(link.person_id) : undefined;
    if (!person || person.disabled) return { status: 'closed', message: refusal('closed', await business()).message };
    const actor: PersonActor = { kind: 'person', personId: person.id, roles: person.roles };
    const item = (await deps.inbox(actor)).find((i) => i.id === link.item_id);
    if (item) return { actor, item, name: person.name };
    // Not in their inbox any more: decided already, or no longer theirs (a role they lost).
    if (await itemPending(link.item_id ?? '')) {
      return { status: 'forbidden', message: `This is no longer yours to decide: it needs a role you don't have now. Open MemWise to see who can.` };
    }
    return { status: 'closed', message: 'This was already dealt with, so there is nothing left to do here.' };
  }

  async function itemPending(itemId: string): Promise<boolean> {
    const [kind, ...rest] = itemId.split(':');
    const id = rest.join(':');
    if (kind === 'step') return ((await pool.query(`select 1 from mw.step_runs where id = $1 and status = 'waiting'`, [id])).rowCount ?? 0) > 0;
    if (kind === 'approval') {
      return ((await pool.query(
        `select 1 from mw.approvals a join mw.step_runs s on s.id = a.step_run_id where a.id = $1 and a.status = 'pending' and s.status = 'waiting'`, [id])).rowCount ?? 0) > 0;
    }
    if (kind === 'attention') {
      const [runId, state] = [rest.slice(0, -1).join(':'), rest.at(-1)];
      return ((await pool.query(`select 1 from mw.runs where id = $1 and state = $2 and status <> 'done'`, [runId, state])).rowCount ?? 0) > 0;
    }
    return false;
  }

  const display = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(display).join(', ');
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.amount === 'number' && typeof o.currency === 'string') return `${o.currency} ${o.amount.toLocaleString('en-IN')}`;
      if (typeof o.name === 'string') return o.name;
      return Object.entries(o).map(([k, x]) => `${plainLabel(k)}: ${display(x)}`).join('; ');
    }
    return String(v);
  };

  const outcomeComment = (id: string): 'none' | 'optional' | 'required' => (/back|reject|decline|change|return/.test(id) ? 'required' : 'optional');

  async function inboxLinkView(link: LinkRow, actor: PersonActor, item: InboxItem, name: string): Promise<InboxLinkItem> {
    const base: Pick<InboxLinkItem, 'status' | 'business' | 'person' | 'expiresAt'> = {
      status: 'open', business: await business(), person: firstName(name), expiresAt: iso(link.expires_at),
    };
    const openInApp = `memwise://inbox/item/${encodeURIComponent(item.id)}`;
    if (item.kind === 'identity' || item.kind === 'reminder' || item.kind === 'conversation') {
      return { ...base, kind: 'attention', title: await itemTitle(item), caseTitle: '', fields: [], openInApp };
    }
    const run = (await runInfo(pool, item.runId))!;
    const workflow = await workflowOf(run.workflow_id, run.workflow_hash);
    const cTitle = await caseTitle(workflow, item.caseId);
    const values = await caseValues(pool, item.caseId);
    const stepId = item.kind === 'attention' ? undefined : item.stepId;
    const step = stepId ? workflow.steps[stepId] : undefined;
    const fields = (step?.reads ?? []).map((r) => r.replace(/^case\./, '').split('.')[0]!)
      .filter((f, i, all) => all.indexOf(f) === i && values[f] !== undefined && maySee(actor, workflow.caseType.fields[f]))
      .map((f) => ({ label: plainLabel(f), value: display(values[f]!.value) }));
    if (item.kind === 'approval') {
      const d = (item.approval.preview.detail ?? {}) as { to?: unknown; subject?: unknown; body?: unknown };
      return {
        ...base, kind: 'approval', title: `Approve: ${item.approval.preview.summary}`, caseTitle: cTitle, fields,
        outcomes: [{ id: 'approved', label: 'Approve', comment: 'optional' }, { id: 'rejected', label: 'Reject', comment: 'optional' }],
        preview: compact({
          summary: item.approval.preview.summary, to: typeof d.to === 'string' ? d.to : undefined,
          subject: typeof d.subject === 'string' ? d.subject : undefined, body: typeof d.body === 'string' ? d.body : undefined,
        }),
      };
    }
    if (item.kind === 'decision') {
      return {
        ...base, kind: 'decision', title: step?.title ?? plainLabel(item.stepId), caseTitle: cTitle, fields,
        outcomes: (step?.outcomes ?? []).map((id) => ({ id, label: plainLabel(id), comment: outcomeComment(id) })),
      };
    }
    return {
      ...base, kind: item.kind, title: item.kind === 'attention' ? `${cTitle}: ${item.reason}` : step?.title ?? plainLabel(item.stepId),
      caseTitle: cTitle, fields, openInApp,
    };
  }

  // ---------------------------------------------------------------- the service

  const service: ExternalKernelService = {
    inviteTool,
    publicBase,
    itemTitle,

    async issueLink({ runId, stepId, participant, note, expiresInMs, by }) {
      const run = await runInfo(pool, runId);
      if (!run || run.status !== 'active') throw new Error('this case is not open, so no link can be sent for it');
      const workflow = await workflowOf(run.workflow_id, run.workflow_hash);
      const step = workflow.steps[stepId];
      if (!step || step.performer !== 'external') throw new Error(`${stepId} is not a step for someone outside the business`);
      const forbidden = mayManage(by, workflow, stepId);
      if (forbidden) throw Object.assign(new Error(forbidden), { code: 'forbidden' });
      const current = run.state === stepId ? `${run.id}/${run.entered_seq}/${stepId}` : undefined;
      const { row, token } = await insertLink(pool, await linksKey(), {
        kind: 'step', idemKey: randomLinkKey('copy'), runId, caseId: run.case_id, stepId, ...(current ? { stepRunId: current } : {}),
        participant: compact({ name: participant.name?.trim(), email: participant.email?.trim(), phone: participant.phone?.trim() }),
        via: 'copy', ...(note?.trim() ? { note } : {}), createdBy: by.personId,
        expiresInMs: expiryMs(expiresInMs, await stateTimeout(workflow, stepId)),
      });
      const base = publicBase();
      return { link: linkSummary(row), token, ...(base ? { url: `${base}/f/${token}` } : {}) };
    },

    async links(filter) {
      const { rows } = await pool.query(
        `select * from mw.external_links
          where ($1::text is null or case_id = $1) and ($2::text is null or run_id = $2) and ($3::text is null or person_id = $3)
          order by created_at desc, id desc limit 200`,
        [filter.caseId ?? null, filter.runId ?? null, filter.personId ?? null]);
      return rows.map(linkSummary);
    },

    async revoke(linkId, by) {
      const m = await managed(linkId, by);
      if ('message' in m) return { applied: false, message: m.message };
      const r = await pool.query(
        `update mw.external_links set closed_at = now(), closed_reason = 'revoked'
          where id = $1 and used_at is null and closed_at is null and expires_at > now()`, [linkId]);
      return r.rowCount ? { applied: true } : { applied: false, message: `This link is already ${linkStatus(m.link)}.` };
    },

    async previewResend({ linkId, via }) {
      const link = await linkById(pool, linkId);
      if (!link) return { message: `no link ${linkId}` };
      const parts = await resendParts(link, via);
      if (!('base' in parts)) return parts;
      const m = parts.message;
      return compact({ to: m.to, via: m.via, subject: m.subject, body: m.body.replace(/\/f\/mwl_[A-Za-z0-9_-]+/, '/f/mwl_•••') });
    },

    async resend({ linkId, via, by }) {
      const m = await managed(linkId, by);
      if ('message' in m) return { applied: false, message: m.message };
      const parts = await resendParts(m.link, via);
      if (!('base' in parts)) return { applied: false, message: parts.message };
      const run = (await runInfo(pool, m.link.run_id))!;
      const stepRunId = m.link.step_run_id ?? `${run.id}/${run.entered_seq}/${m.link.step_id}`;
      const token: StepToken = { ...componentToken(run, m.workflow, m.link.step_id!, stepRunId, by.personId), agentRole: `${m.workflow.id}.${m.link.step_id}.resend` };
      try {
        const delivery = await deliver(pool, deps.tools(), {
          message: parts.message, idemKey: `resend:${linkId}:${Date.now()}`, purpose: 'invite', token, linkId, caseId: m.link.case_id,
          approvedBy: by.personId,
        });
        await pool.query(`update mw.external_links set sent_at = now(), via = $2 where id = $1`, [linkId, parts.message.via]);
        return { applied: true, delivery };
      } catch (e) {
        return { applied: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    // ---- the public form

    async form(token, _info?: PublicRequestInfo) {
      const opened = await openStep(token);
      if ('message' in opened) return opened;
      const { link, at } = opened;
      await pool.query(
        `update mw.external_links set first_opened_at = coalesce(first_opened_at, now()), last_opened_at = now() where id = $1`, [link.id]);
      const values = await caseValues(pool, at.run.case_id);
      const mine = Object.fromEntries(Object.keys(at.step.writes).map((k) => [k, values[k]]));
      return buildForm({
        step: at.step, business: await business(), participant: compact({ name: link.participant?.name }), values: mine,
        draft: link.draft, ...(link.draft_saved_at ? { draftSavedAt: iso(link.draft_saved_at) } : {}),
        comments: await formComments(link, at.stepRunId), suggestions: link.suggestions ?? [], expiresAt: iso(link.expires_at),
      });
    },

    async saveDraft(token, values) {
      const opened = await openStep(token);
      if ('message' in opened) return opened;
      const { link, at } = opened;
      const kept = Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => Object.hasOwn(at.step.writes, k)));
      const text = JSON.stringify(kept);
      if (text.length > DRAFT_MAX_BYTES) return { status: 'rate_limited', message: 'This draft is too large to save. Please shorten what you typed.' };
      const { rows } = await pool.query(
        `update mw.external_links set draft = $2, draft_saved_at = now() where id = $1 returning draft_saved_at`, [link.id, text]);
      return { savedAt: iso(rows[0].draft_saved_at) };
    },

    async upload(token, file) {
      const opened = await openStep(token);
      if ('message' in opened) return opened;
      const { link } = opened;
      const data = file.data;
      if (!data?.byteLength) return { status: 'invalid', message: 'This file is empty.' };
      if (data.byteLength > MAX_FILE_BYTES) return { status: 'invalid', message: `This file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB. Please upload a smaller one.` };
      const mime = sniffType(data);
      if (!mime || !ACCEPTED_TYPES.includes(mime)) {
        return { status: 'invalid', message: "This kind of file can't be used here. Please upload a PDF, a photo (JPEG, PNG, HEIC or WebP) or a text file." };
      }
      if ((link.files ?? []).length >= MAX_FILES) return { status: 'invalid', message: `You can upload at most ${MAX_FILES} files with this form.` };
      const name = (file.name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || 'upload';
      const meta = await withTransaction(pool, async (db) => {
        const locked = await linkById(db, link.id, true);
        if (!locked || (locked.files ?? []).length >= MAX_FILES) return undefined;
        const saved = await deps.files.save(db, { name, mime, data }, `external:${link.id}`);
        await db.query(`update mw.external_links set files = files || to_jsonb($2::text) where id = $1`, [link.id, saved.id]);
        return saved;
      });
      if (!meta) return { status: 'invalid', message: `You can upload at most ${MAX_FILES} files with this form.` };
      return { document: formDocument(meta) };
    },

    async extract(token, input) {
      const opened = await openStep(token, 'extract');
      if ('message' in opened) return opened;
      const { link, at } = opened;
      if (!at.step.extract) return { suggestions: [], notes: ["This form doesn't read documents; please type the answers in."] };
      const current = (await caseValues(pool, at.run.case_id))[at.step.extract.documents]?.value;
      const { docs } = await documentValues(pool, link, (input?.documents ?? []).slice(0, MAX_FILES), current);
      const r = await runExtraction({
        db: pool, tools: deps.tools(), files: deps.files, workflow: at.workflow, step: at.step, stepRunId: at.stepRunId, run: at.run,
        documents: docs, onBehalfOf: `external:${link.id}`, policy: await stepPolicy(at.workflow, at.step.id),
        records: { ...deps.entities(), ...at.workflow.caseType.types }, forParticipant: true,
      });
      if (r.suggestions.length) {
        await pool.query(`update mw.external_links set suggestions = suggestions || $2::jsonb where id = $1`, [link.id, JSON.stringify(r.suggestions)]);
      }
      return { suggestions: r.suggestions.map(formSuggestion), ...(r.notes.length ? { notes: r.notes } : {}) };
    },

    async submit(token, input: ExternalSubmitInput): Promise<ExternalSubmitResult> {
      const opened = await openStep(token, 'submit');
      if ('message' in opened) return opened;
      const name = await business();
      return withTransaction(pool, async (db) => {
        const link = await linkById(db, opened.link.id, true);
        if (!link) return refusal('unknown', name);
        const status = linkStatus(link);
        if (status !== 'open') return refusal(status, name);
        const at = await resolve(db, link);
        if (typeof at === 'string') return refusal(at, name);
        const s = await lockWaitingStep(db, at.stepRunId);
        if ('applied' in s) return refusal('closed', name);
        const step = at.step;
        const outcome = input?.outcome ?? (step.outcomes.length === 1 ? step.outcomes[0] : undefined);
        if (!outcome || !step.outcomes.includes(outcome)) {
          return { status: 'invalid', errors: { outcome: [`choose one of: ${step.outcomes.map(plainLabel).join(', ')}`] }, message: 'Please choose what to send.' };
        }
        const values = cleanValues(input?.values ?? {});
        const errors: Record<string, string[]> = {};
        const current = await caseValues(db, at.run.case_id);
        for (const [field, w] of Object.entries(step.writes)) {
          if (!Object.hasOwn(values, field) || !isDocType(w.type)) continue;
          const { docs, bad } = await documentValues(db, link, values[field], current[field]?.value);
          if (bad) (errors[field] ??= []).push('this file was not uploaded with this form');
          values[field] = w.type.kind === 'list' ? docs : docs[0];
        }
        for (const [field, errs] of Object.entries(await answerErrors(db, step, at.run.case_id, values, { ...deps.entities(), ...at.workflow.caseType.types }))) {
          (errors[field] ??= []).push(...errs);
        }
        if (Object.keys(errors).length) return { status: 'invalid', errors, message: 'Some answers need fixing.' };
        const label = participantLabel(link.participant);
        const now = new Date().toISOString();
        const provenance = input?.sources ? keptProvenance(link.suggestions ?? [], values, input.sources, label, now) : {};
        // A value sent back unchanged (the form shows what the case has) keeps where it came from.
        for (const [field, v] of Object.entries(values)) {
          const had = current[field];
          if (!provenance[field] && had?.provenance && Object.hasOwn(step.writes, field) && isDeepStrictEqual(had.value, v)) provenance[field] = had.provenance;
        }
        const queued = await queueSubmission(db, deps.client, s, outcome, {
          stepRunId: at.stepRunId, by: `external:${link.id}`, at: now, values, external: { linkId: link.id, label },
          ...(Object.keys(provenance).length ? { provenance } : {}),
        });
        if (!queued) return refusal('closed', name);
        await db.query(`update mw.external_links set step_run_id = coalesce(step_run_id, $2) where id = $1`, [link.id, at.stepRunId]);
        await closeStepLinks(db, at.run.id, step.id, 'answered', link.id);
        return { status: 'applied', message: `Thank you. Your answers were sent to ${name}.` };
      });
    },

    async extractForStep({ stepRunId, documents, by }) {
      const { rows } = await pool.query(
        `select s.id, s.status, s.step_id, s.workflow_id, s.workflow_hash, s.run_id, s.case_id from mw.step_runs s where s.id = $1`, [stepRunId]);
      const s = rows[0];
      if (!s || s.status !== 'waiting') throw new Error('this step is no longer waiting for an answer');
      const workflow = await workflowOf(s.workflow_id, s.workflow_hash);
      const step = workflow.steps[s.step_id];
      if (!step?.extract || (step.performer !== 'person' && step.performer !== 'external')) throw new Error(`${s.step_id} doesn't read documents`);
      if (step.assignee && !by.roles.includes(step.assignee)) {
        throw Object.assign(new Error(`only someone with the ${step.assignee} role can fill in this step`), { code: 'forbidden' });
      }
      const docs: DocumentValue[] = [];
      for (const id of documents.slice(0, MAX_FILES)) {
        const meta = await deps.files.meta(pool, id);
        if (meta) docs.push(meta);
      }
      const r = await runExtraction({
        db: pool, tools: deps.tools(), files: deps.files, workflow, step, stepRunId, run: { id: s.run_id, case_id: s.case_id },
        documents: docs, onBehalfOf: by.personId, policy: await stepPolicy(workflow, step.id),
        records: { ...deps.entities(), ...workflow.caseType.types }, forParticipant: false,
      });
      if (r.suggestions.length) {
        await pool.query(`update mw.step_runs set suggestions = suggestions || $2::jsonb where id = $1`, [stepRunId, JSON.stringify(r.suggestions)]);
      }
      return { suggestions: r.suggestions.map(formSuggestion), ...(r.notes.length ? { notes: r.notes } : {}) } satisfies ExtractResult;
    },

    async sourcedProvenance(db, stepRunId, values, sources, by) {
      const { rows } = await db.query(`select suggestions from mw.step_runs where id = $1`, [stepRunId]);
      return keptProvenance((rows[0]?.suggestions ?? []) as StoredSuggestion[], values, sources, by, new Date().toISOString());
    },

    // ---- inbox links

    async issueInboxLink({ personId, item, via, idemKey }) {
      const base = publicBase();
      if (!base || item.kind === 'identity') return undefined;
      const { row, token } = await insertLink(pool, await linksKey(), {
        kind: 'inbox', idemKey: idemKey ?? randomLinkKey(`inbox:${personId}:${item.id}`), runId: item.runId, caseId: item.caseId, personId, itemId: item.id,
        ...('stepRunId' in item && item.stepRunId ? { stepRunId: item.stepRunId } : item.kind === 'approval' ? { stepRunId: item.approval.stepRunId } : {}),
        participant: {}, via, createdBy: 'system', expiresInMs: INBOX_LINK_MS,
      });
      return { link: linkSummary(row), url: `${base}/i/${token}`, title: await itemTitle(item) };
    },

    async inboxItem(token): Promise<InboxLinkAnswer> {
      const link = await open(token, 'inbox');
      if ('message' in link) return link;
      const found = await inboxLinkItem(link);
      if ('status' in found) return { status: 'closed', message: found.message };
      await pool.query(
        `update mw.external_links set first_opened_at = coalesce(first_opened_at, now()), last_opened_at = now() where id = $1`, [link.id]);
      return inboxLinkView(link, found.actor, found.item, found.name);
    },

    async decideInboxItem(token, decision: InboxLinkDecision): Promise<InboxLinkResult> {
      const link = await open(token, 'inbox', 'submit');
      if ('message' in link) return link;
      const found = await inboxLinkItem(link);
      if ('status' in found) return found.status === 'forbidden' ? { status: 'forbidden', message: found.message } : { status: 'closed', message: found.message };
      const { actor, item } = found;
      const channel = link.via ?? 'email';
      const how = channel === 'whatsapp' ? 'via WhatsApp link' : 'via email link';
      const comment = decision?.comment?.trim() || undefined;
      const done = async (message: string): Promise<InboxLinkResult> => {
        await pool.query(`update mw.external_links set used_at = now() where id = $1 and used_at is null`, [link.id]);
        return { status: 'applied', message };
      };
      if (item.kind === 'decision') {
        const r = await deps.submitStep({ stepRunId: item.stepRunId, outcome: decision?.outcome, ...(comment ? { comment } : {}), by: actor }, { channel });
        if (r.applied) return done(`Done: ${plainLabel(decision.outcome).toLowerCase()}, recorded as you (${how}).`);
        if (r.status === 'forbidden') return { status: 'forbidden', message: r.message ?? 'You may not decide this.' };
        if (r.status === 'stale' || r.status === 'missing') return { status: 'closed', message: 'This was already dealt with, so there is nothing left to do here.' };
        return { status: 'invalid', message: r.message ?? 'That answer was not accepted.' };
      }
      if (item.kind === 'approval') {
        if (decision?.outcome !== 'approved' && decision?.outcome !== 'rejected') return { status: 'invalid', message: 'Choose approve or reject.' };
        const r = await deps.decideApproval(
          { id: item.approval.id, status: decision.outcome, by: actor.personId, ...(comment ? { comment } : {}), at: new Date().toISOString() }, actor);
        if (r.applied) {
          await pool.query(`update mw.approvals set decided_via = $2 where id = $1`, [item.approval.id, channel]);
          return done(`Done: ${decision.outcome === 'approved' ? 'approved' : 'rejected'}, recorded as you (${how}).`);
        }
        if (r.status === 'forbidden') return { status: 'forbidden', message: 'You may not decide this approval.' };
        return { status: 'closed', message: 'This was already dealt with, so there is nothing left to do here.' };
      }
      return { status: 'invalid', message: 'This needs typing in MemWise: open it there.' };
    },
  };
  return service;
}


/** The kernel's external tools as definitions only, for checks and stubs (like `authoringToolDefinitions`). */
export function externalToolDefinitions(): ToolDefinition[] {
  return [{
    ...externalInviteShape(),
    async execute() { throw new Error('external.invite runs only inside a kernel'); },
  } as ToolDefinition];
}
