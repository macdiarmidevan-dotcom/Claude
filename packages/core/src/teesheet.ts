import { DateTime } from "luxon";

/** A rule for which tee times a course offers on a given day. */
export interface TeeSheetTemplate {
  /** ISO weekdays this template applies to: 1 = Monday ... 7 = Sunday. */
  weekdays: number[];
  /** First tee time of the day, local "HH:mm". */
  firstTee: string;
  /** Last tee time of the day, local "HH:mm" (inclusive). */
  lastTee: string;
  /** Minutes between tee times. */
  intervalMinutes: number;
  /** Maximum players per tee time, usually 4. */
  maxPlayers: number;
}

export interface GeneratedTeeTime {
  /** Start time as a UTC ISO string. */
  startsAt: string;
  /** Local wall-clock time "HH:mm" at the course. */
  localTime: string;
  maxPlayers: number;
}

function parseHHmm(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time "${value}", expected HH:mm`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${value}"`);
  return { hour, minute };
}

/**
 * Generates the tee times for one local date at a course.
 * Uses the first template whose weekdays include the date; returns [] if none apply.
 */
export function generateTeeTimes(
  date: string,
  timeZone: string,
  templates: TeeSheetTemplate[],
): GeneratedTeeTime[] {
  const day = DateTime.fromISO(date, { zone: timeZone });
  if (!day.isValid) throw new Error(`Invalid date "${date}"`);

  const template = templates.find((t) => t.weekdays.includes(day.weekday));
  if (!template) return [];
  if (template.intervalMinutes <= 0) throw new Error("intervalMinutes must be positive");

  const first = parseHHmm(template.firstTee);
  const last = parseHHmm(template.lastTee);
  const firstMinute = first.hour * 60 + first.minute;
  const lastMinute = last.hour * 60 + last.minute;

  const times: GeneratedTeeTime[] = [];
  // Step through local wall-clock minutes so the sheet stays on its grid across DST changes.
  for (let m = firstMinute; m <= lastMinute; m += template.intervalMinutes) {
    const t = day.set({ hour: Math.floor(m / 60), minute: m % 60, second: 0, millisecond: 0 });
    times.push({
      startsAt: t.toUTC().toISO()!,
      localTime: t.toFormat("HH:mm"),
      maxPlayers: template.maxPlayers,
    });
  }
  return times;
}
