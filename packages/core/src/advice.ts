import { DateTime } from "luxon";
import { findRate, type RateRule } from "./rates.ts";

// Recommended rates: a suggested green fee for each day of the week and time of day, worked out
// from the course's own tee sheet. Nothing here changes a price; managers read the number and
// decide. The API and the demo both feed it the same per-tee-time rows.
//
// How it works, per day and time band:
// - Fill = players who came (no-shows left out) over the open spots on the tee sheet.
// - Without price tests we can't know whether the course's overall price level is right, so the
//   advice takes it as right at a time that is as full as the course's average, and reshapes
//   prices around it: busy times are priced up, quiet times down.
// - Golfers are assumed to care less about price at busy times than at quiet ones. At a time as
//   full as average, the price response is set so today's rate earns the most (counting carts and
//   extras); it grows at quieter times and shrinks at busier ones by the square root of how much
//   less or more full they are. Demand falls in a straight line as the price goes up.
// - A band that was at least 90% full is treated as turned-away demand: 15% more golfers wanted
//   those times than got them.
// - Players can't go past 90% of the spots (or what already played, if more), which leaves room
//   for walk-ups and pace of play.
// - Each whole-dollar price within 15% of today's rate is tried, and the one with the most money
//   per available spot (green fee plus carts and extras) wins. It has to beat today's rate by 0.2%,
//   or the advice is to keep the price.

export const ADVICE_ASSUMPTIONS = {
  /** How much more price-sensitive golfers are at quieter times: response × (average fill / fill) ^ this. */
  busyBend: 0.5,
  targetFill: 0.9,
  fullAt: 0.9,
  turnedAway: 1.15,
  maxChange: 0.15,
  minGain: 0.002,
  /** Fewer open spots than this in a band and there isn't enough to go on. */
  minSpots: 100,
  noShowNote: 0.1,
};

export type TimeBand = "early" | "morning" | "afternoon" | "twilight";

export const TIME_BANDS: { id: TimeBand; label: string; start: string; end: string }[] = [
  { id: "early", label: "Before 9 AM", start: "00:00", end: "09:00" },
  { id: "morning", label: "9 AM to noon", start: "09:00", end: "12:00" },
  { id: "afternoon", label: "Noon to 3 PM", start: "12:00", end: "15:00" },
  { id: "twilight", label: "3 PM and later", start: "15:00", end: "24:00" },
];

export const bandOf = (time: string): TimeBand => TIME_BANDS.find((b) => time >= b.start && time < b.end)!.id;

/** One open tee time in the period looked at. Money is what players in it paid. */
export interface AdviceTeeTime {
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  /** Local "HH:mm". */
  time: string;
  spots: number;
  /** Players who weren't no-shows. */
  players: number;
  noShows: number;
  /** First-loop green fees paid by those players. */
  greenFeeCents: number;
  /** Carts, rentals and other extras on their bookings. */
  extrasCents: number;
}

export type AdviceStatus = "raise" | "lower" | "hold" | "no_data" | "no_rate";

export interface AdviceCell {
  weekday: number;
  band: TimeBand;
  spots: number;
  players: number;
  fillPct: number | null;
  noShowPct: number | null;
  /** The standard (nonresident adult) rate at these times today. */
  currentCents: number | null;
  currentRateName: string | null;
  recommendedCents: number | null;
  status: AdviceStatus;
  /** Green fees plus extras per open spot, as it went. */
  revenuePerSpotCents: number | null;
  /** The same, expected at the recommended price. */
  projectedRevenuePerSpotCents: number | null;
  /** Expected change in players and money per week at the recommended price. */
  weeklyPlayersChange: number;
  weeklyGainCents: number;
  reason: string;
}

export interface RateAdviceResult {
  cells: AdviceCell[];
  /** Players over open spots across every band with enough data: the "average time" prices are shaped around. */
  averageFillPct: number;
  /** The expected extra money per week if every recommendation were followed. */
  weeklyGainCents: number;
}

const DAY_NAME = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const pctText = (x: number) => `${Math.round(x * 100)}%`;

/** The rate a walk-up nonresident adult pays on that weekday at that time. */
function standardRate(rates: RateRule[], weekday: number, time: string, timeZone: string) {
  // 2026-01-05 is a Monday; no holidays are passed, so only the weekday and time decide.
  const local = DateTime.fromObject({ year: 2026, month: 1, day: 4 + weekday, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) }, { zone: timeZone });
  return findRate(rates, { residency: "nonresident", ageGroup: "adult" }, { startsAt: local.toISO()!, timeZone });
}

export function recommendRates(input: { teeTimes: AdviceTeeTime[]; rates: RateRule[]; timeZone: string; weeks: number }): RateAdviceResult {
  const a = ADVICE_ASSUMPTIONS;
  const weeks = Math.max(1, input.weeks);
  const rates = input.rates.filter((r) => !r.isReplay);
  const groups = [];
  for (let weekday = 1; weekday <= 7; weekday++)
    for (const band of TIME_BANDS) {
      const times = input.teeTimes.filter((t) => t.weekday === weekday && bandOf(t.time) === band.id);
      const sum = (k: "spots" | "players" | "noShows" | "greenFeeCents" | "extrasCents") => times.reduce((s, t) => s + t[k], 0);
      const first = times.map((t) => t.time).sort()[0];
      groups.push({
        weekday,
        band,
        spots: sum("spots"),
        players: sum("players"),
        noShows: sum("noShows"),
        green: sum("greenFeeCents"),
        extras: sum("extrasCents"),
        rate: first ? standardRate(rates, weekday, first, input.timeZone) : undefined,
      });
    }
  // The course's average fill over the bands there's enough data for.
  const enough = groups.filter((g) => g.spots >= a.minSpots);
  const allSpots = enough.reduce((s, g) => s + g.spots, 0);
  const average = allSpots ? enough.reduce((s, g) => s + g.players, 0) / allSpots : 0;

  const cells: AdviceCell[] = groups.map(({ weekday, band, spots, players, noShows, green, extras, rate }) => {
    const fill = spots ? players / spots : null;
    const noShowPct = players + noShows ? Math.round((noShows / (players + noShows)) * 1000) / 10 : null;
    const base: AdviceCell = {
      weekday,
      band: band.id,
      spots,
      players,
      fillPct: fill === null ? null : Math.round(fill * 1000) / 10,
      noShowPct,
      currentCents: rate?.priceCents ?? null,
      currentRateName: rate?.name ?? null,
      recommendedCents: null,
      status: "no_data",
      revenuePerSpotCents: spots ? Math.round((green + extras) / spots) : null,
      projectedRevenuePerSpotCents: null,
      weeklyPlayersChange: 0,
      weeklyGainCents: 0,
      reason: "Not enough tee times in this period to recommend a price.",
    };
    if (spots < a.minSpots || fill === null || !average) return base;
    if (!rate) return { ...base, status: "no_rate", reason: "No standard rate covers these times." };

    const p0 = rate.priceCents;
    const paid = players ? green / players : p0;
    const extrasPer = players ? extras / players : 0;
    // The price response that makes today's rate the best one at an average time, bent for busier or quieter times.
    const relative = Math.min(4, Math.max(0.25, fill / average));
    const response = (-1 / (1 + extrasPer / paid)) * Math.pow(relative, -a.busyBend);
    const full = fill >= a.fullAt;
    const demand = players * (full ? a.turnedAway : 1);
    const cap = Math.max(spots * a.targetFill, players);
    const playersAt = (p: number) => Math.min(Math.max(0, demand * (1 + response * (p / p0 - 1))), cap);
    const revenueAt = (p: number) => playersAt(p) * (paid * (p / p0) + extrasPer);

    let best = p0;
    const lo = Math.ceil((p0 * (1 - a.maxChange)) / 100) * 100;
    const hi = Math.floor((p0 * (1 + a.maxChange)) / 100) * 100;
    for (let p = lo; p <= hi; p += 100) {
      const better = revenueAt(p) - revenueAt(best);
      if (better > 0.5 || (Math.abs(better) <= 0.5 && Math.abs(p - p0) < Math.abs(best - p0))) best = p;
    }
    if (revenueAt(best) - revenueAt(p0) < revenueAt(p0) * a.minGain) best = p0;

    const status: AdviceStatus = best > p0 ? "raise" : best < p0 ? "lower" : "hold";
    const weeklyPlayers = (playersAt(best) - playersAt(p0)) / weeks;
    const weeklyGain = (revenueAt(best) - revenueAt(p0)) / weeks;
    const when = `${DAY_NAME[weekday]} ${band.label.toLowerCase()}`;
    const vs = `against ${pctText(average)} across the week`;
    let reason =
      status === "raise"
        ? full
          ? `${when} was ${pctText(fill)} full, so more golfers likely wanted these times than got them. At ${dollars(best)} it should still fill and bring in about ${dollars(Math.round(weeklyGain))} more a week.`
          : `${when} was ${pctText(fill)} full, ${vs}. Golfers who want busy times care less about price, so ${dollars(best)} is expected to bring in about ${dollars(Math.round(weeklyGain))} more a week.`
        : status === "lower"
          ? `${when} was only ${pctText(fill)} full, ${vs}. At ${dollars(best)} about ${Math.max(1, Math.round(weeklyPlayers))} more players a week are expected, about ${dollars(Math.round(weeklyGain))} more a week counting carts and extras.`
          : `${when} was ${pctText(fill)} full, ${vs}. A different price isn't expected to bring in more.`;
    if (noShowPct !== null && noShowPct / 100 >= a.noShowNote) reason += ` ${Math.round(noShowPct)}% of booked players didn't show; a card on file may help more than price.`;
    return {
      ...base,
      recommendedCents: best,
      status,
      projectedRevenuePerSpotCents: revenueAt(p0) ? Math.round(((revenueAt(best) / revenueAt(p0)) * (green + extras)) / spots) : base.revenuePerSpotCents,
      weeklyPlayersChange: Math.round(weeklyPlayers * 10) / 10,
      weeklyGainCents: Math.round(weeklyGain),
      reason,
    };
  });
  return { cells, averageFillPct: Math.round(average * 1000) / 10, weeklyGainCents: cells.reduce((s, c) => s + c.weeklyGainCents, 0) };
}
