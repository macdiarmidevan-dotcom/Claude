import { describe, expect, it } from "vitest";
import { generateTeeTimes, type TeeSheetTemplate } from "../src/index.ts";

const tz = "America/Chicago";
const everyDay: TeeSheetTemplate = {
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  firstTee: "07:00",
  lastTee: "08:00",
  intervalMinutes: 10,
  maxPlayers: 4,
};

describe("generateTeeTimes", () => {
  it("fills the day on the interval, including the last tee time", () => {
    const times = generateTeeTimes("2026-07-01", tz, [everyDay]);
    expect(times.map((t) => t.localTime)).toEqual(["07:00", "07:10", "07:20", "07:30", "07:40", "07:50", "08:00"]);
    // July is daylight time, UTC-5.
    expect(times[0]!.startsAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("uses the course's standard time offset in winter", () => {
    const times = generateTeeTimes("2026-12-01", tz, [everyDay]);
    expect(times[0]!.startsAt).toBe("2026-12-01T13:00:00.000Z");
  });

  it("stays on the local grid across a DST change", () => {
    // DST ends 2026-11-01 at 2am Central.
    const overnight = { ...everyDay, firstTee: "00:30", lastTee: "03:30", intervalMinutes: 60 };
    expect(generateTeeTimes("2026-11-01", tz, [overnight]).map((t) => t.localTime)).toEqual([
      "00:30",
      "01:30",
      "02:30",
      "03:30",
    ]);
  });

  it("picks the template for the weekday and returns nothing on closed days", () => {
    const weekendsOnly = { ...everyDay, weekdays: [6, 7], firstTee: "06:00", lastTee: "06:00" };
    expect(generateTeeTimes("2026-07-04", tz, [weekendsOnly])).toHaveLength(1); // Saturday
    expect(generateTeeTimes("2026-07-06", tz, [weekendsOnly])).toEqual([]); // Monday
  });
});
