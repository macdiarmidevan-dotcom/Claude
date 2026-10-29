// Reads a tee sheet exported from another booking system (TeeItUp, GolfNow, a spreadsheet)
// into bookings we can line up with our tee sheet. Exports differ in column names and
// formats, so headers are matched loosely and every row that can't be read is reported.

export interface ImportedBooking {
  /** The other system's booking id, or one made from date, time and name when it has none. */
  externalId: string;
  /** Local date "yyyy-MM-dd". */
  date: string;
  /** Local time "HH:mm". */
  time: string;
  name: string;
  players: number;
  holes?: number;
  email?: string;
  phone?: string;
  totalCents?: number;
  /** Money already taken by the other system (paid online). */
  paidCents?: number;
  status: "booked" | "cancelled" | "no_show";
  notes?: string;
}

export interface ImportProblem {
  /** 1-based line number in the file, counting the header as line 1. */
  line: number;
  message: string;
}

export interface ParsedImport {
  bookings: ImportedBooking[];
  problems: ImportProblem[];
  /** Columns we recognised, by field, for showing the person what was read. */
  columns: Partial<Record<Field, string>>;
}

type Field = "id" | "date" | "time" | "datetime" | "name" | "players" | "holes" | "email" | "phone" | "total" | "paid" | "status" | "notes";

const ALIASES: Record<Field, string[]> = {
  id: ["confirmation", "confirmation #", "confirmation number", "booking id", "reservation id", "reservation #", "reference", "id", "order id"],
  date: ["date", "tee date", "play date", "reservation date"],
  time: ["time", "tee time", "start time"],
  datetime: ["tee time date", "date/time", "date time", "start"],
  name: ["name", "golfer", "golfer name", "player", "player name", "customer", "customer name", "booked by", "lead golfer"],
  players: ["players", "golfers", "# players", "# of players", "number of players", "party size", "qty", "quantity", "rounds"],
  holes: ["holes", "# holes"],
  email: ["email", "e-mail", "email address"],
  phone: ["phone", "phone number", "mobile"],
  total: ["total", "total price", "price", "amount", "green fee", "rate", "booking total"],
  paid: ["paid", "prepaid", "amount paid", "paid amount", "paid online", "prepaid amount"],
  status: ["status", "booking status", "reservation status"],
  notes: ["notes", "note", "comments", "comment"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Splits CSV text into rows, handling quoted fields with commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === "," || c === "\t") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "2026-10-28", "10/28/2026" or "10/28/26" → "2026-10-28". */
export function parseDate(value: string): string | undefined {
  const v = value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(v);
  if (m) return ymd(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[1]!, +m[2]!);
  return undefined;
}

function ymd(y: number, mo: number, d: number): string | undefined {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "7:02 AM", "7:02am", "07:02" or "19:02" → "HH:mm". */
export function parseTime(value: string): string | undefined {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?/i.exec(value.trim());
  if (!m) return undefined;
  let h = +m[1]!;
  const min = +m[2]!;
  const ap = m[3]?.toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "$1,234.50", "29" or "29.00" → cents. */
export function parseMoney(value: string): number | undefined {
  const v = value.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(v)) return undefined;
  return Math.round(Number(v) * 100);
}

function parseStatus(value: string): ImportedBooking["status"] | undefined {
  const v = norm(value);
  if (!v || ["booked", "confirmed", "reserved", "active", "paid", "checked in", "checked-in", "arrived"].includes(v)) return "booked";
  if (["cancelled", "canceled", "void", "voided", "deleted"].includes(v)) return "cancelled";
  if (["no show", "no-show", "noshow"].includes(v)) return "no_show";
  return undefined;
}

/** A short stable id for rows without a confirmation number. */
function madeUpId(date: string, time: string, name: string): string {
  let h = 2166136261;
  for (const c of `${date}|${time}|${norm(name)}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return `row-${date}-${time.replace(":", "")}-${(h >>> 0).toString(36)}`;
}

export function parseTeeSheetCsv(text: string): ParsedImport {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const problems: ImportProblem[] = [];
  const bookings: ImportedBooking[] = [];
  if (rows.length === 0) return { bookings, problems: [{ line: 1, message: "The file is empty" }], columns: {} };

  const header = rows[0]!.map(norm);
  const index: Partial<Record<Field, number>> = {};
  const columns: Partial<Record<Field, string>> = {};
  for (const field of Object.keys(ALIASES) as Field[]) {
    const i = header.findIndex((h) => ALIASES[field].includes(h));
    if (i >= 0) {
      index[field] = i;
      columns[field] = rows[0]![i]!.trim();
    }
  }
  const missing = [
    index.date === undefined && index.datetime === undefined && "date",
    index.time === undefined && index.datetime === undefined && "tee time",
    index.name === undefined && "golfer name",
  ].filter(Boolean);
  if (missing.length) {
    return { bookings, problems: [{ line: 1, message: `Couldn't find a column for ${missing.join(", ")}. Found: ${rows[0]!.join(", ")}` }], columns };
  }

  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (f: Field) => (index[f] === undefined ? "" : (r[index[f]!] ?? "").trim());
    const date = parseDate(get("date") || get("datetime"));
    const time = parseTime(get("time") || get("datetime"));
    const name = get("name");
    if (!date) return problems.push({ line, message: `Can't read the date "${get("date") || get("datetime")}"` });
    if (!time) return problems.push({ line, message: `Can't read the tee time "${get("time") || get("datetime")}"` });
    if (!name) return problems.push({ line, message: "No golfer name" });
    const players = get("players") ? Number(get("players")) : 1;
    if (!Number.isInteger(players) || players < 1 || players > 8) return problems.push({ line, message: `Can't read the number of players "${get("players")}"` });
    const holes = get("holes") ? Number(get("holes")) : undefined;
    if (holes !== undefined && (!Number.isInteger(holes) || holes < 1 || holes > 36)) return problems.push({ line, message: `Can't read holes "${get("holes")}"` });
    const status = parseStatus(get("status"));
    if (!status) return problems.push({ line, message: `Unknown status "${get("status")}"` });

    const totalCents = get("total") ? parseMoney(get("total")) : undefined;
    // "Paid" may be an amount or a yes/no; yes means the whole total was paid online.
    const paidRaw = get("paid");
    const paidCents = !paidRaw
      ? undefined
      : /^(y|yes|true|paid)$/i.test(paidRaw)
        ? totalCents
        : /^(n|no|false|unpaid)$/i.test(paidRaw)
          ? 0
          : parseMoney(paidRaw);

    const externalId = get("id") || madeUpId(date, time, name);
    if (seen.has(externalId)) return problems.push({ line, message: `Booking ${externalId} appears more than once` });
    seen.add(externalId);
    bookings.push({
      externalId,
      date,
      time,
      name,
      players,
      holes,
      email: get("email") || undefined,
      phone: get("phone") || undefined,
      totalCents,
      paidCents,
      status,
      notes: get("notes") || undefined,
    });
  });
  return { bookings, problems, columns };
}
