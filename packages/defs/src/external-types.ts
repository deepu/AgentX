/**
 * External participants (docs/memwise/23-phase-5-interfaces.md §3-6): links, the public form,
 * extraction suggestions and inbox links.
 *
 * PHASE 5 CONTRACT. The kernel returns these shapes, the public handler sends them as JSON,
 * and the form app (`apps/external-form`) renders them, so this file imports nothing at run
 * time and is safe in a browser bundle (`import type` from `@memwise/defs/external`).
 * Change only additively.
 */

// ---------------------------------------------------------------- links (§3)

export type ExternalLinkKind = 'step' | 'inbox';

/**
 * Where a link stands. `open` until it is used; `used` by its accepted submission; `closed` when
 * the step it opens was answered another way or left; `expired`; `revoked` by staff.
 */
export type ExternalLinkStatus = 'open' | 'used' | 'closed' | 'expired' | 'revoked';

export type ChannelName = 'email' | 'whatsapp';

export interface ExternalParticipant { name?: string; email?: string; phone?: string }

/** A link as staff see it on the case (never the token). */
export interface ExternalLinkSummary {
  id: string;
  kind: ExternalLinkKind;
  status: ExternalLinkStatus;
  runId: string;
  caseId: string;
  /** The external step it opens (kind `step`). */
  stepId?: string;
  /** The step run it was used on, once it opened one. */
  stepRunId?: string;
  participant: ExternalParticipant;
  /** How it was delivered; `copy` when staff copied it to send themselves. */
  via?: ChannelName | 'copy';
  note?: string;
  createdAt: string;
  createdBy?: string;
  expiresAt: string;
  sentAt?: string;
  firstOpenedAt?: string;
  lastOpenedAt?: string;
  draftSavedAt?: string;
  usedAt?: string;
  closedAt?: string;
  closedReason?: string;
  /** Inbox links: the person and the item. */
  personId?: string;
  itemId?: string;
}

/** Why a link can't be used now, in words the participant reads. */
export interface LinkRefusal {
  status: 'unknown' | 'expired' | 'used' | 'closed' | 'revoked' | 'not_yet' | 'rate_limited';
  message: string;
}

// ---------------------------------------------------------------- the public form (§4)

export type ExternalFieldKind =
  | 'text' | 'longtext' | 'email' | 'phone' | 'identifier' | 'number' | 'money' | 'date' | 'boolean' | 'enum'
  | 'document' | 'documents';

/** Where a field's current value came from, for its badge. */
export type ExternalValueSource =
  | { kind: 'case' }                                       // already on the case (sent back, or staff typed it)
  | { kind: 'draft' }                                      // the participant's saved draft
  | { kind: 'extracted'; suggestionId: string; document: string; confidence: number };

export interface ExternalDocument { id: string; name: string; mime: string; size: number }

export interface ExternalFormField {
  name: string;
  label: string;
  kind: ExternalFieldKind;
  required: boolean;
  /** Help under the field. */
  help?: string;
  placeholder?: string;
  /** A regular expression the value must match (identifiers), checked again by the core. */
  pattern?: string;
  /** Upper-case what is typed (identifiers such as PAN and GSTIN). */
  upperCase?: boolean;
  options?: { value: string; label: string }[];
  /** Money: the currency the amount is in. */
  currency?: string;
  /** The current value, in the shape the core accepts back (`money` is `{ amount, currency }`, documents `ExternalDocument[]`). */
  value?: unknown;
  source?: ExternalValueSource;
}

export interface ExternalComment {
  /** The author's first name only ("Ravi"), or "MemWise" for a note the playbook wrote. */
  from: string;
  text: string;
  at: string;
}

export interface ExternalForm {
  status: 'open';
  /** Shown at the top: who is asking. */
  business: string;
  title: string;
  /** The step's instructions, Markdown. */
  instructions: string;
  participant: { name?: string };
  fields: ExternalFormField[];
  /** Comments returned to this step, and the link's note, newest last. */
  comments: ExternalComment[];
  /** The outcome a submission takes when the step has more than one, by label. */
  outcomes: { id: string; label: string }[];
  /** Extraction is offered (the step has `extract:`). */
  extract?: { documentsField: string; fields: string[]; minConfidence: number };
  /** Suggestions already made on this link (after a reload). */
  suggestions: ExtractSuggestion[];
  draftSavedAt?: string;
  expiresAt: string;
  limits: { maxFileBytes: number; maxFiles: number; accept: string[] };
}

export type ExternalFormAnswer = ExternalForm | LinkRefusal;

export interface ExtractSuggestion {
  id: string;
  /** The step write it is for. */
  field: string;
  value: unknown;
  /** 0..1 after grounding (capped at 0.5 when the value is not found in the document's text). */
  confidence: number;
  /** The document's name. */
  document: string;
  documentId: string;
  /** The text it was read from, when the reader quoted it. */
  quote?: string;
  /** The value was found in the document's text. */
  found: boolean;
  /** At or above the step's min_confidence and found: pre-filled. */
  prefill: boolean;
}

export interface ExtractResult { suggestions: ExtractSuggestion[]; notes?: string[] }

export interface ExternalSubmitInput {
  outcome?: string;
  values: Record<string, unknown>;
  /** field -> suggestion id, for values taken from a suggestion. */
  sources?: Record<string, string>;
}

export type ExternalSubmitResult =
  | { status: 'applied'; message: string }
  | { status: 'invalid'; errors: Record<string, string[]>; message: string }
  | LinkRefusal;

// ---------------------------------------------------------------- inbox links (§6)

export interface InboxLinkItem {
  status: 'open';
  business: string;
  kind: 'decision' | 'approval' | 'input' | 'attention';
  title: string;
  /** Who it is for (their first name). */
  person: string;
  caseTitle: string;
  /** The fields the step reads, as the person may see them. */
  fields: { label: string; value: string }[];
  /** Decision items: the outcomes; `comment` when it should come with one (send back). */
  outcomes?: { id: string; label: string; comment: 'none' | 'optional' | 'required' }[];
  /** Effect approvals: what would be sent. */
  preview?: { summary: string; to?: string; subject?: string; body?: string };
  /** Items that need typed values open in the app instead. */
  openInApp?: string;
  expiresAt: string;
}

export type InboxLinkAnswer = InboxLinkItem | LinkRefusal;

export interface InboxLinkDecision {
  /** Decision items: the outcome; approvals: `approved` | `rejected`. */
  outcome: string;
  comment?: string;
}

export type InboxLinkResult = { status: 'applied'; message: string } | { status: 'invalid' | 'forbidden'; message: string } | LinkRefusal;

// ---------------------------------------------------------------- channels (§6-7)

export interface Delivery {
  id: string;
  channel: ChannelName;
  to: string;
  purpose: 'invite' | 'reminder' | 'notification';
  linkId?: string;
  personId?: string;
  itemId?: string;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  providerId?: string;
  at: string;
}

export interface NotifySettings { email?: boolean; whatsapp?: string }

export interface WebhookSummary {
  id: string;
  purpose: string;
  plugin?: string;
  scheme: 'hmac-sha256' | 'meta';
  /** The public address to give the sender. */
  url?: string;
  createdAt: string;
  lastReceivedAt?: string;
}

export interface InboundEvent {
  id: string;
  hookId: string;
  receivedAt: string;
  verified: boolean;
  headers: Record<string, string>;
  body: unknown;
}
