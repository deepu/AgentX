// Plain words for triggers (the Automations screen, 24 §7): "When a Site enters Activating",
// "30 days before a Person's CV expires", "Every 2 weeks", "When an email arrives at etmf".
import { splitEntityKey, type TriggerDef } from '@memwise/defs';

const DAY = 86_400_000;
const UNITS: [ms: number, one: string][] = [[7 * DAY, 'week'], [DAY, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1000, 'second']];

/** 30 days, 2 weeks, 12 hours: the largest unit that divides it. */
export function durationWords(ms: number): string {
  for (const [unit, one] of UNITS) {
    if (ms >= unit && ms % unit === 0) {
      const n = ms / unit;
      return n === 1 ? `1 ${one}` : `${n} ${one}s`;
    }
  }
  return `${ms} ms`;
}

/** Short words kept in lower case when a field name is turned into words. */
const SMALL = new Set(['a', 'an', 'at', 'by', 'in', 'is', 'of', 'on', 'or', 'to', 'up', 'no', 'as', 'be', 'do', 'go', 'if', 'it', 'me', 'my', 'so', 'we']);

/** `cv_expires` → "CV expires"; `activating` → "Activating" (with `capital`). */
export function words(name: string, capital = false): string {
  const parts = name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\s]+/).filter(Boolean)
    .map((w) => (w.length <= 2 && !SMALL.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const s = parts.join(' ');
  return capital && s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);
/** `etmf.Site` → Site. */
const entityName = (name: string) => splitEntityKey(name).entity;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function describeTrigger(t: TriggerDef): string {
  switch (t.kind) {
    case 'entered':
      return `When ${article(entityName(t.entity))} enters ${words(t.state, true)}`;
    case 'created':
      return `When ${article(entityName(t.entity))} is created`;
    case 'changed': {
      const e = entityName(t.entity);
      if (!t.fields?.length) return `When ${article(e)} changes`;
      const names = t.fields.map((f) => words(f));
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
      return `When ${article(e)}'s ${list} changes`;
    }
    case 'date': {
      const e = entityName(t.entity);
      const field = words(t.field.includes('.') ? t.field.slice(t.field.lastIndexOf('.') + 1) : t.field);
      return t.offsetMs
        ? `${durationWords(t.offsetMs)} ${t.direction} ${article(e)}'s ${field}`
        : `On ${article(e)}'s ${field}`;
    }
    case 'every': {
      const every = t.everyMs === DAY ? 'Every day' : t.everyMs === 7 * DAY ? 'Every week' : `Every ${durationWords(t.everyMs)}`;
      const on = t.on && WEEKDAYS.includes(t.on.toLowerCase()) ? ` on ${words(t.on, true)}` : t.on ? ` on ${t.on}` : '';
      return `${every}${on}${t.at ? ` at ${t.at}` : ''}`;
    }
    case 'message':
      return `When an email arrives at ${t.address}`;
  }
}

/** "300 cases would start from Activate a site" (the storm guard's inbox item). */
export function heldWords(held: number, workflowTitle: string): string {
  return `${held} ${held === 1 ? 'case' : 'cases'} would start from ${workflowTitle}`;
}
