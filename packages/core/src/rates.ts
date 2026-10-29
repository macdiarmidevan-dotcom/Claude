import { DateTime } from "luxon";

export type Residency = "resident" | "nonresident";
export type AgeGroup = "adult" | "senior" | "junior";

/** ISO weekday 1-7, plus 8 for a course holiday (holidays match only rules that include 8). */
export const HOLIDAY = 8;

export interface RateRule {
  id: string;
  name: string;
  priceCents: number;
  /** ISO weekdays (1 = Monday ... 7 = Sunday) and/or HOLIDAY. */
  days: number[];
  /** Local "HH:mm" window, start inclusive, end exclusive. Null = all day. */
  startTime?: string | null;
  endTime?: string | null;
  /** Null = any residency. */
  residency?: Residency | null;
  /** Null = any age group. */
  ageGroups?: AgeGroup[] | null;
  /** A replay rate is charged for each extra loop after the first (e.g. holes 10-18 on a 9-hole course). */
  isReplay?: boolean;
}

export interface PlayerProfile {
  residency: Residency;
  ageGroup: AgeGroup;
}

export interface RateContext {
  /** Tee time start as an ISO string. */
  startsAt: string;
  timeZone: string;
  /** Local dates ("yyyy-MM-dd") the course treats as holidays. */
  holidays?: string[];
}

export interface PlayerQuote {
  player: PlayerProfile;
  lines: { rateId: string; name: string; priceCents: number }[];
  totalCents: number;
}

function specificity(rule: RateRule): number {
  let score = 0;
  if (rule.residency) score++;
  if (rule.ageGroups && rule.ageGroups.length > 0) score++;
  if (rule.startTime || rule.endTime) score++;
  return score;
}

function matches(rule: RateRule, player: PlayerProfile, day: number, localTime: string): boolean {
  if (!rule.days.includes(day)) return false;
  if (rule.residency && rule.residency !== player.residency) return false;
  if (rule.ageGroups && rule.ageGroups.length > 0 && !rule.ageGroups.includes(player.ageGroup)) return false;
  if (rule.startTime && localTime < rule.startTime) return false;
  if (rule.endTime && localTime >= rule.endTime) return false;
  return true;
}

/**
 * Picks the rate for one player: among matching rules, the most specific wins,
 * and ties go to the lower price so a golfer is never overcharged by rule order.
 */
export function findRate(
  rules: RateRule[],
  player: PlayerProfile,
  ctx: RateContext,
  replay = false,
): RateRule | undefined {
  const local = DateTime.fromISO(ctx.startsAt, { zone: ctx.timeZone });
  if (!local.isValid) throw new Error(`Invalid startsAt "${ctx.startsAt}"`);
  const isHoliday = ctx.holidays?.includes(local.toFormat("yyyy-MM-dd")) ?? false;
  const day = isHoliday ? HOLIDAY : local.weekday;
  const localTime = local.toFormat("HH:mm");

  const candidates = rules.filter(
    (r) => Boolean(r.isReplay) === replay && matches(r, player, day, localTime),
  );
  candidates.sort((a, b) => specificity(b) - specificity(a) || a.priceCents - b.priceCents);
  return candidates[0];
}

/**
 * Prices one player's round. `loops` is how many times they play the course:
 * 18 holes on a 9-hole course is 2 loops, the first at the normal rate and the rest at the replay rate.
 */
export function quotePlayer(
  rules: RateRule[],
  player: PlayerProfile,
  ctx: RateContext,
  loops = 1,
): PlayerQuote {
  const base = findRate(rules, player, ctx);
  if (!base) throw new NoRateError(player, ctx);
  const lines = [{ rateId: base.id, name: base.name, priceCents: base.priceCents }];
  for (let i = 1; i < loops; i++) {
    const replay = findRate(rules, player, ctx, true);
    if (!replay) throw new NoRateError(player, ctx);
    lines.push({ rateId: replay.id, name: replay.name, priceCents: replay.priceCents });
  }
  return { player, lines, totalCents: lines.reduce((sum, l) => sum + l.priceCents, 0) };
}

export class NoRateError extends Error {
  constructor(player: PlayerProfile, ctx: RateContext) {
    super(`No rate for a ${player.residency} ${player.ageGroup} at ${ctx.startsAt}`);
    this.name = "NoRateError";
  }
}
