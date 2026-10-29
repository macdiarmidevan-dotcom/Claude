import { describe, expect, it } from "vitest";
import { quotePlayer, riverBend, riverBendRates, type PlayerProfile } from "../src/index.ts";

const tz = riverBend.timeZone;
const resident: PlayerProfile = { residency: "resident", ageGroup: "adult" };
const nonresident: PlayerProfile = { residency: "nonresident", ageGroup: "adult" };
const residentSenior: PlayerProfile = { residency: "resident", ageGroup: "senior" };
const nonresidentJunior: PlayerProfile = { residency: "nonresident", ageGroup: "junior" };

// 2026-11-03 is a Tuesday, 2026-11-06 a Friday, 2026-11-07 a Saturday (all Central time).
const tuesday = "2026-11-03T09:00:00-06:00";
const fridayMorning = "2026-11-06T09:00:00-06:00";
const fridayAfternoon = "2026-11-06T13:00:00-06:00";
const saturday = "2026-11-07T09:00:00-06:00";

const price = (player: PlayerProfile, startsAt: string, loops = 1, holidays?: string[]) =>
  quotePlayer(riverBendRates, player, { startsAt, timeZone: tz, holidays }, loops).totalCents;

describe("River Bend rates", () => {
  it("charges weekday resident and nonresident rates", () => {
    expect(price(resident, tuesday)).toBe(2300);
    expect(price(nonresident, tuesday)).toBe(2900);
  });

  it("gives seniors and juniors the weekday discount", () => {
    expect(price(residentSenior, tuesday)).toBe(2100);
    expect(price(nonresidentJunior, tuesday)).toBe(2400);
  });

  it("charges weekend rates Friday to Sunday", () => {
    expect(price(resident, fridayAfternoon)).toBe(2500);
    expect(price(nonresident, saturday)).toBe(3100);
  });

  it("has no weekend senior or junior discount, except seniors on Friday mornings", () => {
    expect(price(residentSenior, saturday)).toBe(2500);
    expect(price(residentSenior, fridayMorning)).toBe(2100);
    expect(price(residentSenior, fridayAfternoon)).toBe(2500);
    expect(price(nonresidentJunior, fridayMorning)).toBe(3100);
  });

  it("treats holidays as weekend days", () => {
    expect(price(resident, tuesday, 1, ["2026-11-03"])).toBe(2500);
  });

  it("adds the replay rate for 18 holes", () => {
    const quote = quotePlayer(riverBendRates, nonresident, { startsAt: tuesday, timeZone: tz }, 2);
    expect(quote.lines.map((l) => l.priceCents)).toEqual([2900, 1500]);
    expect(quote.totalCents).toBe(4400);
    expect(price(resident, saturday, 2)).toBe(2500 + 1800);
  });
});
