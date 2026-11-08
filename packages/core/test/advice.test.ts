import { describe, expect, it } from "vitest";
import { bandOf, recommendRates, riverBend, riverBendRates, type AdviceTeeTime } from "../src/index.ts";

const tz = riverBend.timeZone;

/** Eight weeks of one weekday's tee times in a band, each with the same share of its 4 spots filled. */
function band(weekday: number, times: string[], fill: number, opts: { riding?: number; noShows?: number } = {}): AdviceTeeTime[] {
  const out: AdviceTeeTime[] = [];
  let i = 0;
  for (let week = 0; week < 8; week++)
    for (const time of times) {
      // Spread the players so the band as a whole is filled to that share.
      const players = Math.round(4 * fill * (i + 1)) - Math.round(4 * fill * i++);
      out.push({ weekday, time, spots: 4, players, noShows: opts.noShows ?? 0, greenFeeCents: players * 2900, extrasCents: Math.round(players * (opts.riding ?? 0) * 1300) });
    }
  return out;
}
const morning = ["09:00", "09:08", "09:16", "09:24", "09:32", "09:40", "09:48", "09:56", "10:04", "10:12", "10:20", "10:28"];
const cellFor = (rows: AdviceTeeTime[], weekday: number, b = "morning") =>
  recommendRates({ teeTimes: rows, rates: riverBendRates, timeZone: tz, weeks: 8 }).cells.find((c) => c.weekday === weekday && c.band === b)!;

describe("recommended rates", () => {
  it("puts tee times in time bands", () => {
    expect(bandOf("06:30")).toBe("early");
    expect(bandOf("09:00")).toBe("morning");
    expect(bandOf("14:59")).toBe("afternoon");
    expect(bandOf("18:00")).toBe("twilight");
  });

  it("raises the price where the tee sheet is full", () => {
    const c = cellFor([...band(2, morning, 1), ...band(3, morning, 0.5)], 2);
    expect(c.currentCents).toBe(2900);
    expect(c.status).toBe("raise");
    expect(c.recommendedCents).toBeGreaterThan(2900);
    expect(c.recommendedCents).toBeLessThanOrEqual(3300); // at most 15% more
    expect(c.weeklyGainCents).toBeGreaterThan(0);
    expect(c.reason).toMatch(/Tuesday 9 am to noon was 100% full/);
  });

  it("shapes prices around the average: quiet times down, busy times up, never more than 15%", () => {
    const rows = [...band(1, morning, 0.8, { riding: 0.6 }), ...band(2, morning, 0.5, { riding: 0.6 }), ...band(3, morning, 0.2, { riding: 0.6 })];
    const busy = cellFor(rows, 1);
    const average = cellFor(rows, 2);
    const quiet = cellFor(rows, 3);
    expect(busy.status).toBe("raise");
    expect(average.status).toBe("hold");
    expect(average.recommendedCents).toBe(2900);
    expect(average.weeklyGainCents).toBe(0);
    expect(quiet.status).toBe("lower");
    expect(quiet.recommendedCents).toBeGreaterThanOrEqual(2500);
    expect(quiet.recommendedCents! % 100).toBe(0);
    expect(quiet.weeklyPlayersChange).toBeGreaterThan(0);
    expect(quiet.reason).toMatch(/against 50% across the week/);
  });

  it("keeps the price when every time is about as full", () => {
    const c = cellFor([...band(1, morning, 0.85), ...band(2, morning, 0.85)], 1);
    expect(c.fillPct).toBeCloseTo(85, 0);
    expect(c.status).toBe("hold");
  });

  it("uses the weekend rate Friday to Sunday", () => {
    expect(cellFor(band(6, morning, 0.75), 6).currentCents).toBe(3100);
  });

  it("says when there isn't enough to go on, and mentions no-shows", () => {
    expect(cellFor(band(4, ["09:00"], 1), 4).status).toBe("no_data");
    expect(cellFor([...band(5, morning, 0.5, { noShows: 1 }), ...band(1, morning, 0.9)], 5).reason).toMatch(/didn't show/);
  });

  it("adds up the expected weekly gain", () => {
    const result = recommendRates({ teeTimes: [...band(2, morning, 1), ...band(3, morning, 0.5)], rates: riverBendRates, timeZone: tz, weeks: 8 });
    expect(result.weeklyGainCents).toBe(result.cells.reduce((s, c) => s + c.weeklyGainCents, 0));
    expect(result.cells).toHaveLength(28);
    expect(result.averageFillPct).toBeCloseTo(75, 0);
  });
});
