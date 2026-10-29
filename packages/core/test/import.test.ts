import { describe, expect, it } from "vitest";
import { parseCsv, parseDate, parseMoney, parseTeeSheetCsv, parseTime } from "../src/import.ts";

describe("tee sheet import", () => {
  it("reads quoted CSV fields", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n')).toEqual([["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
  });

  it("reads common date, time and money formats", () => {
    expect(parseDate("10/28/2026")).toBe("2026-10-28");
    expect(parseDate("10/28/26")).toBe("2026-10-28");
    expect(parseDate("2026-10-28")).toBe("2026-10-28");
    expect(parseDate("2/30/2026")).toBeUndefined();
    expect(parseTime("7:02 AM")).toBe("07:02");
    expect(parseTime("12:10pm")).toBe("12:10");
    expect(parseTime("12:05 AM")).toBe("00:05");
    expect(parseTime("19:02")).toBe("19:02");
    expect(parseMoney("$1,234.50")).toBe(123450);
    expect(parseMoney("abc")).toBeUndefined();
  });

  it("reads a TeeItUp-style export with loose headers", () => {
    const csv = [
      "Confirmation #,Tee Date,Tee Time,Golfer Name,# Players,Holes,Email,Total,Paid Online,Status",
      "TIU-1001,10/28/2026,7:02 AM,Mike Sullivan,4,18,mike@example.com,$116.00,$116.00,Confirmed",
      'TIU-1002,10/28/2026,7:10 AM,"Kowalski, Dana",2,9,,$58.00,No,Confirmed',
      "TIU-1003,10/28/2026,7:18 AM,Jim Nowak,2,9,,$58.00,,Cancelled",
    ].join("\n");
    const { bookings, problems, columns } = parseTeeSheetCsv(csv);
    expect(problems).toEqual([]);
    expect(columns).toMatchObject({ id: "Confirmation #", name: "Golfer Name", paid: "Paid Online" });
    expect(bookings[0]).toMatchObject({ externalId: "TIU-1001", date: "2026-10-28", time: "07:02", players: 4, holes: 18, totalCents: 11600, paidCents: 11600, status: "booked" });
    expect(bookings[1]).toMatchObject({ name: "Kowalski, Dana", paidCents: 0 });
    expect(bookings[2]!.status).toBe("cancelled");
  });

  it("reports rows it can't read and keeps the rest", () => {
    const csv = ["Date,Time,Name,Players,Status", "10/28/2026,7:02,Ann,2,", "10/28/2026,soon,Bob,1,", "10/28/2026,7:10,,1,", "10/28/2026,7:18,Cy,ten,", "10/28/2026,7:26,Di,1,Lost"].join("\n");
    const { bookings, problems } = parseTeeSheetCsv(csv);
    expect(bookings.map((b) => b.name)).toEqual(["Ann"]);
    expect(problems.map((p) => p.line)).toEqual([3, 4, 5, 6]);
    // Without a confirmation number the id is made from date, time and name, so a re-import matches.
    expect(parseTeeSheetCsv(csv).bookings[0]!.externalId).toBe(bookings[0]!.externalId);
  });

  it("says which columns are missing", () => {
    expect(parseTeeSheetCsv("Who,When\nAnn,today").problems[0]!.message).toMatch(/date, tee time, golfer name/);
  });
});
