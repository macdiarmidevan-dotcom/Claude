// A pretend course that runs entirely in the browser, for showing the app without a server.
// Only built in when EXPO_PUBLIC_DEMO=1. Nothing is saved: reloading the page starts over.
import { generateTeeTimes, parseTeeSheetCsv, quotePlayer, riverBend, riverBendAddOns, riverBendRates, riverBendTeeSheet } from "@golf/core";
import {
  ApiError,
  type ActivityEntry,
  type Client,
  type GolferAccount,
  type GolferProfile,
  type Role,
  type StaffUser,
  type ImportResult,
  type ImportRun,
  type ImportSource,
  type SyncConnection,
  type SyncSettings,
  type PaymentMethod,
  type SheetBooking,
  type SheetTeeTime,
  type Waiver,
  type WaiverSignature,
  type WalkIn,
} from "./api";
import { todayIn } from "./dates";

export const DEMO = process.env.EXPO_PUBLIC_DEMO === "1";
export const DEMO_URL = "demo";

interface DemoBooking extends SheetBooking {
  paid: { amountCents: number; method: PaymentMethod }[];
  externalId?: string;
}
interface DemoTeeTime extends Omit<SheetTeeTime, "bookings" | "bookedPlayers"> {
  date: string;
}

const conflict = (code: string, message: string) => new ApiError(409, code, message);

// Pretend staff accounts. They live outside the client so signing in and the signed-in app share them.
export const DEMO_PASSWORD = "riverbend";
const accounts: (StaffUser & { password: string })[] = [
  { id: "u-1", name: "Morgan Ellis", email: "manager@riverbend.example", role: "manager", active: true, lastLoginAt: null, password: DEMO_PASSWORD },
  { id: "u-2", name: "Jordan Price", email: "proshop@riverbend.example", role: "staff", active: true, lastLoginAt: null, password: DEMO_PASSWORD },
  { id: "u-3", name: "Sam Torres", email: "starter@riverbend.example", role: "staff", active: true, lastLoginAt: null, password: DEMO_PASSWORD },
];
const activity: ActivityEntry[] = [];
const publicUser = ({ password: _, ...u }: StaffUser & { password: string }): StaffUser => u;

export async function demoSignIn(email: string, password: string) {
  await new Promise((r) => setTimeout(r, 200));
  const a = accounts.find((x) => x.email === email.trim().toLowerCase());
  if (!a || a.password !== password) throw new ApiError(401, "wrong_login", "Wrong email or password");
  if (!a.active) throw new ApiError(401, "wrong_login", "This account has been turned off. Ask a manager");
  a.lastLoginAt = new Date().toISOString();
  return { token: `demo-session:${a.id}`, user: publicUser(a) };
}

export function createDemoClient(apiKey: string): Client {
  // A demo sign-in carries the account id; the older demo-manager / demo-staff keys act as shared device keys.
  const account = () => accounts.find((a) => apiKey === `demo-session:${a.id}` && a.active);
  const role = (): Role => account()?.role ?? (apiKey.includes("manager") ? "manager" : "staff");
  const managerOnly = () => {
    if (role() !== "manager") throw new ApiError(403, "manager_only", "Only a manager can change this");
  };
  const log = (action: string, golfer?: string) =>
    activity.unshift({ actor: account()?.name ?? "Shared device key", action, golfer: golfer ?? null, bookingId: null, detail: {}, at: new Date().toISOString() });
  const teeTimes = new Map<string, DemoTeeTime>();
  const days = new Set<string>();
  const bookings: DemoBooking[] = [];
  let waiver: Waiver = {
    id: "waiver-1",
    version: 1,
    title: "Golf Cart Rules and Liability Waiver",
    body:
      "SAMPLE TEXT, NOT LEGAL ADVICE. A manager can replace this with the course's own reviewed waiver.\n\n" +
      "1. I am at least 16 years old and hold a valid driver's license.\n" +
      "2. I will follow all posted cart rules, keep carts on paths where marked, and not drive under the influence.\n" +
      "3. I accept responsibility for damage to the cart caused by misuse, and for my passengers' safety.\n" +
      "4. I release River Bend Golf Club and the Lisle Park District from claims arising from my use of the cart, except where caused by their negligence.",
  };
  const runs: ImportRun[] = [];
  // Golfer accounts, some with rounds from before today so their history isn't empty.
  type DemoGolfer = Omit<GolferAccount, "roundsPlayed" | "lastPlayed"> & { createdBy: string | null; past: GolferProfile["history"] };
  const golfers: DemoGolfer[] = [];
  const pastRounds = (n: number, holes: number) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.now() - (i + 1) * 6 * 86_400_000);
      d.setHours(7 + (i % 4), 10, 0, 0);
      return { bookingId: `past-${nextId++}`, startsAt: d.toISOString(), course: riverBend.name, players: 2 + (i % 3), holes, status: "teed_off" as const, source: "teeitup", totalCents: 4200, paidCents: 4200 };
    });
  let nextId = 1;
  const id = () => `demo-${nextId++}`;

  function payment(b: DemoBooking) {
    const paidCents = b.paid.reduce((s, p) => s + p.amountCents, 0);
    const balanceCents = Math.max(0, b.totalCents - paidCents);
    return {
      status: balanceCents === 0 ? ("paid" as const) : paidCents > 0 ? ("partial" as const) : ("unpaid" as const),
      paidCents,
      balanceCents,
      methods: [...new Set(b.paid.map((p) => p.method))],
    };
  }

  function live(teeTimeId: string) {
    return bookings.filter((b) => b.teeTimeId === teeTimeId && b.status !== "cancelled");
  }

  function ensureDay(date: string) {
    if (days.has(date)) return;
    days.add(date);
    for (const t of generateTeeTimes(date, riverBend.timeZone, riverBendTeeSheet)) {
      const teeTimeId = id();
      teeTimes.set(teeTimeId, { id: teeTimeId, date, startsAt: t.startsAt, localTime: t.localTime, maxPlayers: t.maxPlayers, status: "open", note: null });
    }
    if (date === todayIn(riverBend.timeZone)) seedToday(date);
  }

  const at = (date: string, localTime: string) => [...teeTimes.values()].find((t) => t.date === date && t.localTime === localTime)!;

  function seedToday(date: string) {
    const accounts: Record<string, [string, string, number, number]> = {
      "Mike Sullivan": ["mike.sullivan@example.com", "(630) 555-0141", 23, 18],
      "Dana Kowalski": ["dana.k@example.com", "(630) 555-0177", 8, 9],
      "Chris Patel": ["chris.patel@example.com", "(331) 555-0112", 41, 18],
      "Linda Hart": ["linda.hart@example.com", "(630) 555-0190", 12, 9],
      "Sam Lee": ["sam.lee@example.com", "(331) 555-0123", 5, 9],
    };
    for (const [name, [email, phone, rounds, holes]] of Object.entries(accounts)) {
      golfers.push({ id: id(), name, email, phone, createdAt: new Date(Date.now() - 200 * 86_400_000).toISOString(), createdBy: "Jordan Price", past: pastRounds(rounds, holes) });
    }
    const groups: [string, string, number, number, boolean, string?][] = [
      ["07:02", "Mike Sullivan", 4, 18, true, "teed_off"],
      ["07:10", "Dana Kowalski", 2, 9, false, "teed_off"],
      ["07:18", "Jim & Barb Nowak", 2, 9, true, "no_show"],
      ["07:26", "Tom Reyes", 3, 9, true],
      ["07:34", "Chris Patel", 4, 18, true, "checked_in"],
      ["07:42", "Linda Hart", 1, 9, false],
      ["07:58", "Sam Lee", 2, 9, true, "prepaid"],
      ["08:06", "Greg Olson", 4, 9, true],
      ["08:14", "Ana Ruiz", 2, 18, false],
      ["09:10", "Priya Shah", 3, 9, false, "prepaid"],
      ["09:26", "Bob Kim", 4, 18, true],
      ["10:06", "Tuesday Men's Club", 4, 9, true],
    ];
    for (const [time, name, players, holes, cart, state] of groups) {
      const b = book({
        teeTimeId: at(date, time).id,
        holes,
        customer: { name, email: "demo@example.com" },
        players: Array.from({ length: players }, () => ({ residency: "resident", ageGroup: "adult" })),
        addOns: cart ? [{ code: "gas_cart", quantity: players }] : [],
      });
      if (state === "checked_in" || state === "teed_off") b.paid.push({ amountCents: b.totalCents, method: "card" });
      if (state === "prepaid") b.paid.push({ amountCents: b.totalCents, method: "prepaid" });
      if (state === "checked_in" || state === "teed_off") b.status = state;
      if (state === "no_show") b.status = "no_show";
      b.golferId = golfers.find((g) => g.name === name)?.id ?? null;
      if (state === "teed_off" && cart) {
        b.cartNumbers = Array.from({ length: Math.ceil(players / 2) }, (_, i) => String(10 + i));
        b.signedCarts = [...b.cartNumbers];
      }
    }
    for (const time of ["08:30", "08:38", "08:46"]) Object.assign(at(date, time), { status: "blocked", note: "Senior league shotgun" });
  }

  const played = (status: string) => status === "checked_in" || status === "teed_off";

  function profile(g: DemoGolfer): GolferProfile {
    const today = bookings
      .filter((b) => b.golferId === g.id)
      .map((b) => {
        const t = teeTimes.get(b.teeTimeId)!;
        return { bookingId: b.id, startsAt: t.startsAt, course: riverBend.name, players: b.players, holes: b.holes, status: b.status, source: b.source, totalCents: b.totalCents, paidCents: payment(b).paidCents };
      });
    const history = [...today, ...g.past].sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    const rounds = history.filter((h) => played(h.status));
    const { past: _, ...account } = g;
    return {
      ...account,
      roundsPlayed: rounds.length,
      lastPlayed: rounds[0]?.startsAt ?? null,
      stats: {
        roundsPlayed: rounds.length,
        holesPlayed: rounds.reduce((s, h) => s + h.holes, 0),
        noShows: history.filter((h) => h.status === "no_show").length,
        cancelled: history.filter((h) => h.status === "cancelled").length,
        upcoming: history.filter((h) => h.status === "confirmed" && h.startsAt > new Date().toISOString()).length,
        paidCents: history.reduce((s, h) => s + h.paidCents, 0),
      },
      history,
    };
  }

  function golfer(golferId: string) {
    const g = golfers.find((x) => x.id === golferId);
    if (!g) throw new ApiError(404, "not_found", "Golfer account not found");
    return g;
  }

  const digits = (phone: string) => phone.replace(/\D/g, "");
  function checkGolfer(input: { name?: string; email?: string; phone?: string }, except?: string) {
    if (input.name !== undefined && !input.name.trim()) throw new ApiError(400, "name_required", "Enter the golfer's name");
    if (input.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new ApiError(400, "invalid_email", "Enter a real email address");
    if (input.phone !== undefined && digits(input.phone).length < 10) throw new ApiError(400, "invalid_phone", "Enter a phone number with area code");
    const others = golfers.filter((g) => g.id !== except);
    const sameEmail = input.email && others.find((g) => g.email === input.email!.trim().toLowerCase());
    if (sameEmail) throw conflict("account_exists", `${sameEmail.name} already has an account with that email. Search for them instead`);
    const samePhone = input.phone && others.find((g) => digits(g.phone) === digits(input.phone!));
    if (samePhone) throw conflict("phone_taken", `${samePhone.name} already has an account with that phone number. Search for them instead`);
  }

  function linkBooking(bookingId: string, g: DemoGolfer) {
    const b = find(bookingId);
    Object.assign(b, { golferId: g.id, customerName: g.name, customerPhone: g.phone });
  }

  function find(bookingId: string) {
    const b = bookings.find((x) => x.id === bookingId && x.status !== "cancelled");
    if (!b) throw new ApiError(404, "not_found", "Booking not found");
    return b;
  }

  function book(walkIn: WalkIn) {
    const t = teeTimes.get(walkIn.teeTimeId);
    if (!t) throw new ApiError(404, "not_found", "Tee time not found");
    if (t.status === "blocked") throw conflict("tee_time_blocked", "This tee time is blocked");
    const left = t.maxPlayers - live(t.id).reduce((s, b) => s + b.players, 0);
    if (walkIn.players.length > left) throw conflict("not_enough_spots", `Only ${left} spot${left === 1 ? "" : "s"} left`);
    const loops = Math.max(1, Math.round(walkIn.holes / riverBend.holes));
    let total = 0;
    for (const p of walkIn.players) total += quotePlayer(riverBendRates, p, { startsAt: t.startsAt, timeZone: riverBend.timeZone }, loops).totalCents;
    for (const a of walkIn.addOns) total += (riverBendAddOns.find((x) => x.code === a.code)?.priceCents ?? 0) * a.quantity;
    const b: DemoBooking = {
      id: id(),
      teeTimeId: t.id,
      customerName: walkIn.customer.name,
      customerPhone: null,
      golferId: null,
      players: walkIn.players.length,
      holes: walkIn.holes,
      status: "confirmed",
      source: "staff",
      totalCents: total,
      cartNumbers: [],
      signedCarts: [],
      payment: { status: "unpaid", paidCents: 0, balanceCents: total, methods: [] },
      paid: [],
    };
    bookings.push(b);
    return b;
  }

  function assignCarts(b: DemoBooking, carts: string[], signatures: WaiverSignature[]) {
    const signed = new Set([...b.signedCarts, ...signatures.map((s) => s.cartNumber)]);
    const missing = carts.filter((c) => !signed.has(c));
    if (missing.length) throw conflict("waiver_required", `The driver of cart ${missing.join(", ")} needs to sign the waiver`);
    b.signedCarts = [...signed];
    b.cartNumbers = carts;
  }

  // The same rules as the server's import, on the pretend tee sheet.
  // Pretend online bookings that show up one by one each time the demo syncs.
  let sync: (SyncConnection & { pulls: number }) | null = null;
  const ONLINE: [string, string, number, number][] = [
    ["11:02", "Kelly Brooks", 2, 18],
    ["11:10", "Marcus Webb", 4, 18],
    ["11:34", "Erin Walsh", 1, 9],
    ["12:06", "Raj Mehta", 3, 9],
    ["12:30", "Lisa Chen", 2, 18],
  ];
  const publicSync = (c: typeof sync) => {
    if (!c) return null;
    const { pulls: _, ...rest } = c;
    return rest;
  };

  function importFile(input: { source: ImportSource; csv: string; fileName?: string; dryRun?: boolean; via?: "upload" | "sync" }): ImportResult {
    const parsed = parseTeeSheetCsv(input.csv);
    const dates = [...new Set(parsed.bookings.map((b) => b.date))].sort();
    const result: ImportResult = {
      dryRun: input.dryRun ?? false,
      dates,
      counts: { created: 0, updated: 0, cancelled: 0, unchanged: 0, problems: parsed.problems.length },
      changes: [],
      problems: parsed.problems,
      overbooked: [],
    };
    const before = JSON.stringify([...bookings]);
    const snapshot = bookings.map((b) => ({ ...b }));
    const teeSnapshot = new Map([...teeTimes].map(([k, v]) => [k, { ...v }]));
    dates.forEach(ensureDay);
    for (const row of parsed.bookings) {
      const base = { externalId: row.externalId, date: row.date, time: row.time, name: row.name, players: row.players };
      const existing = bookings.find((b) => b.source === input.source && b.externalId === row.externalId);
      if (row.status === "cancelled") {
        if (existing?.status === "confirmed") {
          existing.status = "cancelled";
          result.changes.push({ ...base, action: "cancel", detail: "Cancelled in the provider's tee sheet" });
          result.counts.cancelled++;
        } else result.changes.push({ ...base, action: existing ? "unchanged" : "skip" });
        continue;
      }
      if (existing && existing.status !== "confirmed" && existing.status !== "cancelled") {
        result.changes.push({ ...base, action: "unchanged", detail: "Already checked in, left as it is" });
        result.counts.unchanged++;
        continue;
      }
      let t = [...teeTimes.values()].find((x) => x.date === row.date && x.localTime === row.time);
      if (!t) {
        const tid = id();
        t = { id: tid, date: row.date, localTime: row.time, startsAt: `${row.date}T${row.time}:00`, maxPlayers: Math.max(4, row.players), status: "open", note: null };
        teeTimes.set(tid, t);
      }
      const holes = row.holes ?? riverBend.holes;
      const loops = Math.max(1, Math.round(holes / riverBend.holes));
      const total =
        row.totalCents ??
        row.players * quotePlayer(riverBendRates, { residency: "nonresident", ageGroup: "adult" }, { startsAt: t.startsAt, timeZone: riverBend.timeZone }, loops).totalCents;
      if (!existing) {
        bookings.push({
          id: id(), teeTimeId: t.id, customerName: row.name, customerPhone: row.phone ?? null, golferId: null, players: row.players, holes,
          status: row.status === "no_show" ? "no_show" : "confirmed", source: input.source, totalCents: total, cartNumbers: [], signedCarts: [],
          payment: { status: "unpaid", paidCents: 0, balanceCents: total, methods: [] },
          paid: row.paidCents ? [{ amountCents: Math.min(row.paidCents, total), method: "prepaid" }] : [], externalId: row.externalId,
        });
        result.changes.push({ ...base, action: "create" });
        result.counts.created++;
        continue;
      }
      const diffs = [
        existing.status === "cancelled" && "rebooked",
        existing.teeTimeId !== t.id && "moved",
        existing.players !== row.players && `players ${existing.players} → ${row.players}`,
        existing.totalCents !== total && "price",
      ].filter(Boolean);
      if (diffs.length === 0) {
        result.changes.push({ ...base, action: "unchanged" });
        result.counts.unchanged++;
        continue;
      }
      Object.assign(existing, { teeTimeId: t.id, players: row.players, holes, totalCents: total, status: "confirmed", customerName: row.name });
      result.changes.push({ ...base, action: "update", detail: diffs.join(", ") });
      result.counts.updated++;
    }
    const inFile = new Set(parsed.bookings.map((b) => b.externalId));
    for (const b of bookings) {
      const t = teeTimes.get(b.teeTimeId);
      if (b.source === input.source && b.externalId && b.status === "confirmed" && t && dates.includes(t.date) && !inFile.has(b.externalId)) {
        b.status = "cancelled";
        result.changes.push({ action: "cancel", externalId: b.externalId, date: t.date, time: t.localTime, name: b.customerName, players: b.players, detail: "No longer in the provider's tee sheet" });
        result.counts.cancelled++;
      }
    }
    if (result.dryRun) {
      bookings.splice(0, bookings.length, ...snapshot);
      teeTimes.clear();
      teeSnapshot.forEach((v, k) => teeTimes.set(k, v));
    } else if (before !== JSON.stringify(bookings) || parsed.bookings.length) {
      runs.unshift({ id: id(), source: input.source, fileName: input.fileName ?? null, dates, counts: result.counts, via: input.via ?? "upload", createdAt: new Date().toISOString() });
    }
    return result;
  }

  // Answers arrive a moment later, like a real server, so loading states still show.
  const reply = <T>(fn: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
    try { resolve(fn()); } catch (e) { reject(e); }
  }, 120));

  return {
    course: () => reply(() => ({ ...riverBend, addOns: riverBendAddOns, rates: riverBendRates })),
    teeSheet: (date: string) =>
      reply(() => {
        ensureDay(date);
        const list = [...teeTimes.values()]
          .filter((t) => t.date === date)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
          .map(({ date: _, ...t }) => {
            const group = live(t.id).map(({ paid: __, ...b }) => ({ ...b, payment: payment({ ...b, paid: __ }) }));
            return { ...t, bookings: group, bookedPlayers: group.filter((b) => b.status !== "no_show").reduce((s, b) => s + b.players, 0) };
          });
        return { date, teeTimes: list };
      }),
    setTeeTime: (teeTimeId: string, patch: { status?: "open" | "blocked"; note?: string | null }) =>
      reply(() => {
        const t = teeTimes.get(teeTimeId)!;
        if (patch.status === "blocked" && live(t.id).length) throw conflict("has_bookings", "Move or cancel the groups before blocking this time");
        return Object.assign(t, patch);
      }),
    book: (walkIn: WalkIn) =>
      reply(() => {
        const b = book(walkIn);
        log("Added a booking", walkIn.customer.name);
        return b;
      }),
    checkIn: (bookingId: string, method?: PaymentMethod) =>
      reply(() => {
        const b = find(bookingId);
        if (b.status !== "confirmed" && b.status !== "no_show") throw conflict("invalid_status", "This group is already checked in");
        const balance = payment(b).balanceCents;
        if (balance > 0 && !method) throw conflict("payment_required", "Take payment before checking in");
        if (balance > 0 && method) b.paid.push({ amountCents: balance, method });
        b.status = "checked_in";
        log("Checked in at the pro shop", b.customerName);
        return b;
      }),
    waiver: () => reply(() => waiver),
    me: () => reply(() => ({ role: role(), user: account() ? publicUser(account()!) : null })),
    logout: () => reply(() => ({ ok: true })),
    changePassword: (current: string, next: string) =>
      reply(() => {
        const a = account();
        if (!a) throw new ApiError(400, "no_account", "Device keys don't have a password");
        if (a.password !== current) throw new ApiError(400, "wrong_password", "Your current password isn't right");
        if (next.length < 8) throw new ApiError(400, "weak_password", "Passwords need at least 8 characters");
        a.password = next;
        return { ok: true };
      }),
    staff: () =>
      reply(() => {
        managerOnly();
        return accounts.map(publicUser).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      }),
    addStaff: (input: { name: string; email: string; role: Role; password: string }) =>
      reply(() => {
        managerOnly();
        const email = input.email.trim().toLowerCase();
        if (accounts.some((a) => a.email === email)) throw conflict("email_taken", "Someone here already uses that email");
        if (input.password.length < 8) throw new ApiError(400, "weak_password", "Passwords need at least 8 characters");
        const a = { id: id(), name: input.name.trim(), email, role: input.role, active: true, lastLoginAt: null, password: input.password };
        accounts.push(a);
        log("Added a staff account");
        return publicUser(a);
      }),
    updateStaff: (userId: string, patch: { name?: string; role?: Role; active?: boolean; password?: string }) =>
      reply(() => {
        managerOnly();
        const a = accounts.find((x) => x.id === userId)!;
        if (a.role === "manager" && a.active && (patch.role === "staff" || patch.active === false)) {
          if (a.id === account()?.id) throw conflict("self_demote", "You can't remove your own manager access. Ask another manager");
          if (!accounts.some((x) => x.id !== a.id && x.role === "manager" && x.active)) throw conflict("last_manager", "The course needs at least one active manager");
        }
        if (patch.password !== undefined && patch.password.length < 8) throw new ApiError(400, "weak_password", "Passwords need at least 8 characters");
        Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
        log("Changed a staff account");
        return publicUser(a);
      }),
    searchGolfers: (q: string) =>
      reply(() => {
        const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        const phone = digits(q);
        return golfers
          .filter((g) => words.every((w) => g.name.toLowerCase().includes(w)) || (phone.length >= 4 && digits(g.phone).includes(phone)) || g.email === q.trim().toLowerCase())
          .map((g) => profile(g))
          .map(({ stats: _, history: __, createdBy: ___, ...a }) => a)
          .sort((a, b) => b.roundsPlayed - a.roundsPlayed || a.name.localeCompare(b.name));
      }),
    golfer: (golferId: string) => reply(() => profile(golfer(golferId))),
    createGolfer: (input: { name: string; email: string; phone: string; bookingId?: string }) =>
      reply(() => {
        checkGolfer(input);
        const g: DemoGolfer = {
          id: id(),
          name: input.name.trim(),
          email: input.email.trim().toLowerCase(),
          phone: input.phone.trim(),
          createdAt: new Date().toISOString(),
          createdBy: account()?.name ?? null,
          past: [],
        };
        golfers.push(g);
        if (input.bookingId) linkBooking(input.bookingId, g);
        log("Created a golfer account", g.name);
        return profile(g);
      }),
    updateGolfer: (golferId: string, patch: { name?: string; email?: string; phone?: string }) =>
      reply(() => {
        const g = golfer(golferId);
        checkGolfer(patch, g.id);
        if (patch.name) g.name = patch.name.trim();
        if (patch.email) g.email = patch.email.trim().toLowerCase();
        if (patch.phone) g.phone = patch.phone.trim();
        log("Changed a golfer account", g.name);
        return profile(g);
      }),
    linkGolfer: (bookingId: string, golferId: string) =>
      reply(() => {
        const g = golfer(golferId);
        linkBooking(bookingId, g);
        log("Linked a golfer account", g.name);
        return profile(g);
      }),
    activity: () =>
      reply(() => {
        managerOnly();
        return activity.slice(0, 100);
      }),
    saveWaiver: (w: { title: string; body: string }) =>
      reply(() => {
        managerOnly();
        log("Changed the cart waiver");
        waiver = { id: `waiver-${waiver.version + 1}`, version: waiver.version + 1, ...w };
        return waiver;
      }),
    importTeeSheet: (input: { source: ImportSource; csv: string; fileName?: string; dryRun?: boolean }) =>
      reply(() => {
        managerOnly();
        if (!input.dryRun) log("Imported the tee sheet");
        return importFile(input);
      }),
    imports: () => reply(() => runs),
    sync: () =>
      reply(() => {
        managerOnly();
        return publicSync(sync);
      }),
    saveSync: (settings: SyncSettings) =>
      reply(() => {
        managerOnly();
        if (settings.method === "report_url") {
          if (!settings.reportUrl) throw new ApiError(400, "url_required", "Paste the report link from your booking system");
          if (!/^https:\/\/[^\s]+$/.test(settings.reportUrl.trim())) throw new ApiError(400, "invalid_url", "The report link must start with https://");
        }
        const hasCredentials = settings.credentials === undefined ? (sync?.hasCredentials ?? false) : settings.credentials !== null;
        sync = {
          source: settings.source,
          method: settings.method,
          reportUrl: settings.reportUrl?.trim() || null,
          hasCredentials,
          enabled: settings.enabled,
          intervalMinutes: settings.intervalMinutes,
          lastRunAt: sync?.lastRunAt ?? null,
          lastStatus: null,
          lastMessage: null,
          pulls: sync?.pulls ?? 0,
        };
        log("Changed tee sheet sync");
        return publicSync(sync)!;
      }),
    removeSync: () =>
      reply(() => {
        managerOnly();
        sync = null;
        log("Turned off tee sheet sync");
        return { ok: true };
      }),
    syncNow: () =>
      reply(() => {
        managerOnly();
        if (!sync) throw new ApiError(400, "not_connected", "Set up tee sheet sync first");
        let result: ImportResult | undefined;
        if (sync.method === "provider_api") {
          sync.lastStatus = "waiting";
          sync.lastMessage = `${sync.source === "golfnow" ? "GolfNow" : "TeeItUp"} hasn't given this course API access yet. Ask your rep for it, and use a report link or a file upload until then.`;
        } else {
          // The demo can't reach a real report link, so it makes one up: each sync brings in one more online booking.
          sync.pulls = Math.min(ONLINE.length, sync.pulls + 1);
          const date = todayIn(riverBend.timeZone);
          const [y, m, d] = date.split("-");
          const csv = ["Confirmation #,Tee Date,Tee Time,Golfer Name,# Players,Holes,Status"]
            .concat(ONLINE.slice(0, sync.pulls).map(([time, name, players, holes], i) => `TIU-${900 + i},${Number(m)}/${Number(d)}/${y},${time},${name},${players},${holes},Confirmed`))
            .join("\n");
          result = importFile({ source: sync.source, csv, fileName: "Automatic sync", via: "sync" });
          const c = result.counts;
          sync.lastStatus = "ok";
          sync.lastMessage = `${c.created} new, ${c.updated} changed, ${c.cancelled} cancelled`;
        }
        sync.lastRunAt = new Date().toISOString();
        log("Synced the tee sheet");
        return { connection: publicSync(sync)!, result };
      }),
    teeOff: (bookingId: string, carts: string[], signatures: WaiverSignature[]) =>
      reply(() => {
        const b = find(bookingId);
        if (b.status !== "checked_in") throw conflict("not_checked_in", "Check this group in at the pro shop first");
        assignCarts(b, carts, signatures);
        b.status = "teed_off";
        log("Sent off the first tee", b.customerName);
        return b;
      }),
    setCarts: (bookingId: string, carts: string[], signatures: WaiverSignature[]) => reply(() => assignCarts(find(bookingId), carts, signatures)),
    noShow: (bookingId: string) =>
      reply(() => {
        log("Marked a no-show", find(bookingId).customerName);
        return Object.assign(find(bookingId), { status: "no_show" as const });
      }),
    cancel: (bookingId: string) =>
      reply(() => {
        log("Cancelled a booking", find(bookingId).customerName);
        return Object.assign(find(bookingId), { status: "cancelled" as const });
      }),
    move: (bookingId: string, teeTimeId: string) =>
      reply(() => {
        const b = find(bookingId);
        const t = teeTimes.get(teeTimeId)!;
        const left = t.maxPlayers - live(t.id).reduce((s, x) => s + x.players, 0);
        if (t.status === "blocked") throw conflict("tee_time_blocked", "This tee time is blocked");
        if (b.players > left) throw conflict("not_enough_spots", `Only ${left} spot${left === 1 ? "" : "s"} left`);
        b.teeTimeId = teeTimeId;
        return b;
      }),
  } as Client;
}
