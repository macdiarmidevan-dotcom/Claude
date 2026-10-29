import { HOLIDAY, type RateRule } from "../rates.ts";
import type { TeeSheetTemplate } from "../teesheet.ts";

/**
 * River Bend Golf Club, Lisle, IL: our first course.
 * Rates are from https://riverbendgolfclub.org/rates.html (2026 season).
 * Hours are not published, so the tee sheet below is a placeholder to confirm with the pro shop.
 */
export const riverBend = {
  slug: "river-bend",
  name: "River Bend Golf Club",
  timeZone: "America/Chicago",
  holes: 9,
  address: "5900 S. Route 53, Lisle, IL 60532",
  phone: "(630) 968-1920",
};

const WEEKDAY = [1, 2, 3, 4]; // Monday-Thursday
const WEEKEND = [5, 6, 7, HOLIDAY]; // Friday-Sunday and holidays

export const riverBendRates: RateRule[] = [
  { id: "wd-res", name: "Weekday resident", priceCents: 2300, days: WEEKDAY, residency: "resident" },
  { id: "wd-nonres", name: "Weekday nonresident", priceCents: 2900, days: WEEKDAY, residency: "nonresident" },
  { id: "wd-res-sj", name: "Weekday resident senior/junior", priceCents: 2100, days: WEEKDAY, residency: "resident", ageGroups: ["senior", "junior"] },
  { id: "wd-nonres-sj", name: "Weekday nonresident senior/junior", priceCents: 2400, days: WEEKDAY, residency: "nonresident", ageGroups: ["senior", "junior"] },
  // "Senior rates apply before 12pm noon on Fridays."
  { id: "fri-am-res-sr", name: "Friday morning resident senior", priceCents: 2100, days: [5], endTime: "12:00", residency: "resident", ageGroups: ["senior"] },
  { id: "fri-am-nonres-sr", name: "Friday morning nonresident senior", priceCents: 2400, days: [5], endTime: "12:00", residency: "nonresident", ageGroups: ["senior"] },
  { id: "we-res", name: "Weekend resident", priceCents: 2500, days: WEEKEND, residency: "resident" },
  { id: "we-nonres", name: "Weekend nonresident", priceCents: 3100, days: WEEKEND, residency: "nonresident" },
  { id: "wd-replay", name: "Weekday replay", priceCents: 1500, days: WEEKDAY, isReplay: true },
  { id: "we-replay", name: "Weekend replay", priceCents: 1800, days: WEEKEND, isReplay: true },
];

export const riverBendAddOns = [
  { code: "gas_cart", name: "Gas cart (per person)", priceCents: 1300 },
  { code: "pull_cart", name: "Pull cart", priceCents: 650 },
  { code: "club_rental", name: "Club rental", priceCents: 1500 },
];

export const riverBendTeeSheet: TeeSheetTemplate[] = [
  { weekdays: [1, 2, 3, 4, 5, 6, 7], firstTee: "06:30", lastTee: "18:00", intervalMinutes: 8, maxPlayers: 4 },
];
