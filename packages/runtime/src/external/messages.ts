// The messages MemWise sends to people (23 §6, D69): fixed templates in plain words, never prose
// from a model. Who is asking, what for, the link, when it expires, and the note.
import type { ChannelName } from '@memwise/defs';
import { firstName, longDate } from './text.ts';

export interface Message { to: string; via: ChannelName; subject?: string; body: string; template?: { name: string; language: string; params: string[] } }

export interface InviteText {
  business: string;
  /** The participant's name, when known. */
  name?: string;
  /** What the form is for: the playbook's title. */
  purpose: string;
  /** The step's title. */
  form: string;
  url: string;
  expiresAt: string | Date;
  note?: string;
}

const hello = (name?: string) => (name?.trim() ? `Hello ${firstName(name)},` : 'Hello,');

/** The invite to an external step's form (`external.invite`, "Send again"). */
export function inviteMessage(via: ChannelName, to: string, t: InviteText): Message {
  const until = longDate(t.expiresAt);
  const note = t.note?.trim();
  if (via === 'whatsapp') {
    const template = process.env.WHATSAPP_INVITE_TEMPLATE?.trim();
    const body = [
      `${hello(t.name)} ${t.business} asks you to fill in a short form for ${t.purpose.toLowerCase()}.`,
      ...(note ? [`They wrote: "${note}"`] : []),
      `Open the form: ${t.url}`,
      `The link works until ${until} and sends the form once. You can save and come back to it.`,
    ].join('\n\n');
    return {
      to, via, body,
      ...(template ? { template: { name: template, language: 'en', params: [firstName(t.name) || 'there', t.business, t.url] } } : {}),
    };
  }
  const body = [
    hello(t.name),
    '',
    `${t.business} asks you to fill in a short form for ${t.purpose.toLowerCase()}: "${t.form}".`,
    ...(note ? ['', 'They wrote:', `"${note}"`] : []),
    '',
    'Open the form here:',
    t.url,
    '',
    `The link works until ${until} and can be used once to send the form. You can save what you have typed and come back to it before then.`,
    '',
    `If you weren't expecting this message, you can ignore it.`,
    '',
    t.business,
  ].join('\n');
  return { to, via, subject: `${t.business}: please fill in a form for ${t.purpose.toLowerCase()}`, body };
}

export interface NotificationText {
  name: string;
  /** "Approve: Client intake for Asha Rao" */
  title: string;
  url: string;
  expiresAt: string | Date;
}

/** An inbox item sent to a person who asked for them by email or WhatsApp. */
export function notificationMessage(via: ChannelName, to: string, t: NotificationText): Message {
  const until = longDate(t.expiresAt);
  const body = via === 'whatsapp'
    ? `${hello(t.name)} something is waiting for you in MemWise: ${t.title}.\n\nOpen it: ${t.url}\n\nThe link works once, until ${until}.`
    : [
        hello(t.name), '', `Something is waiting for you in MemWise: ${t.title}.`, '', 'Open it here:', t.url, '',
        `The link works once, until ${until}. You can also find it in your inbox in MemWise.`,
        '', 'You get these messages because you turned them on in MemWise. You can turn them off in Settings.',
      ].join('\n');
  return { to, via, ...(via === 'email' ? { subject: `Waiting for you: ${t.title}` } : {}), body };
}

/** A link shown in a preview before it exists: the address with the token hidden. */
export const maskedLink = (base: string, prefix: 'f' | 'i') => `${base.replace(/\/+$/, '')}/${prefix}/mwl_•••`;
