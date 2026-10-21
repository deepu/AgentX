// When a kept page refreshes (26 §4): "Refreshes every Monday", "Keep watching, daily until 28 Oct".
// Refreshes run early in the morning, the machine's local time, like the schedules of D76.
import { firstSlot } from '../flow/schedule.ts';

const DAY_MS = 86_400_000;
export const REFRESH_AT = '06:00';
const WEEKDAYS: Record<string, string> = {
  mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday',
};

/** `mon`, `monday`, `Monday` → `mon`; `daily`, `month` as they are; undefined when it is none of these. */
export function normalEvery(every: string | undefined): string | undefined {
  const e = (every ?? '').trim().toLowerCase();
  if (e === 'daily' || e === 'day' || e === 'every day') return 'daily';
  if (e === 'month' || e === 'monthly') return 'month';
  if (e === 'week' || e === 'weekly') return 'mon';
  const short = e.slice(0, 3);
  return WEEKDAYS[short] && WEEKDAYS[short]!.startsWith(e) ? short : undefined;
}

/** The first refresh after `from` (strictly later): the next weekday, day or first of the month at 06:00. */
export function nextRefresh(every: string, from: Date): Date {
  const e = normalEvery(every) ?? 'mon';
  const after = new Date(from.getTime() + 1);
  if (e === 'month') {
    const d = new Date(from.getFullYear(), from.getMonth() + 1, 1, 6, 0, 0, 0);
    return d;
  }
  if (e === 'daily') return firstSlot({ kind: 'every', everyMs: DAY_MS, at: REFRESH_AT, with: {} }, after);
  return firstSlot({ kind: 'every', everyMs: 7 * DAY_MS, at: REFRESH_AT, on: WEEKDAYS[e]!, with: {} }, after);
}
