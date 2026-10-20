// Schedules (`every:`, 24 §7): the first slot and the latest missed one. Times of day are the
// machine's local time, as a person wrote them ("06:00").
import type { TriggerDef } from '@memwise/defs';

type Every = Extract<TriggerDef, { kind: 'every' }>;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The first slot at or after `from`: aligned to `on` (a weekday) and `at` (HH:MM) when given, else one period on. */
export function firstSlot(t: Every, from: Date): Date {
  if (!t.at && !t.on) return new Date(from.getTime() + t.everyMs);
  const [h, m] = (t.at ?? '00:00').split(':').map((x) => Number(x));
  const d = new Date(from);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  const weekday = t.on ? WEEKDAYS.indexOf(t.on.toLowerCase()) : -1;
  if (weekday >= 0) {
    d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
    if (d < from) d.setDate(d.getDate() + 7);
  } else if (d < from) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * The latest slot that is due at `now` (the one a closed desktop catches up with, once) and the
 * slot after it; undefined when nothing is due.
 */
export function dueSlot(nextDue: Date, everyMs: number, now: Date): { slot: Date; next: Date } | undefined {
  if (nextDue > now) return undefined;
  const missed = Math.floor((now.getTime() - nextDue.getTime()) / everyMs);
  const slot = new Date(nextDue.getTime() + missed * everyMs);
  return { slot, next: new Date(slot.getTime() + everyMs) };
}
