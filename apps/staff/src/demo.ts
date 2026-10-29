// A pretend course that runs entirely in the browser, for showing the app without a server.
// Only built in when EXPO_PUBLIC_DEMO=1. Nothing is saved: reloading the page starts over.
import { generateTeeTimes, quotePlayer, riverBend, riverBendAddOns, riverBendRates, riverBendTeeSheet } from "@golf/core";
import {
  ApiError,
  type Client,
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
}
interface DemoTeeTime extends Omit<SheetTeeTime, "bookings" | "bookedPlayers"> {
  date: string;
}

const conflict = (code: string, message: string) => new ApiError(409, code, message);

export function createDemoClient(apiKey: string): Client {
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
      if (state === "teed_off" && cart) {
        b.cartNumbers = Array.from({ length: Math.ceil(players / 2) }, (_, i) => String(10 + i));
        b.signedCarts = [...b.cartNumbers];
      }
    }
    for (const time of ["08:30", "08:38", "08:46"]) Object.assign(at(date, time), { status: "blocked", note: "Senior league shotgun" });
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
    book: (walkIn: WalkIn) => reply(() => book(walkIn)),
    checkIn: (bookingId: string, method?: PaymentMethod) =>
      reply(() => {
        const b = find(bookingId);
        if (b.status !== "confirmed" && b.status !== "no_show") throw conflict("invalid_status", "This group is already checked in");
        const balance = payment(b).balanceCents;
        if (balance > 0 && !method) throw conflict("payment_required", "Take payment before checking in");
        if (balance > 0 && method) b.paid.push({ amountCents: balance, method });
        b.status = "checked_in";
        return b;
      }),
    waiver: () => reply(() => waiver),
    me: () => reply(() => ({ role: apiKey.includes("manager") ? ("manager" as const) : ("staff" as const) })),
    saveWaiver: (w: { title: string; body: string }) =>
      reply(() => {
        if (!apiKey.includes("manager")) throw new ApiError(403, "manager_only", "Only a manager can change this");
        waiver = { id: `waiver-${waiver.version + 1}`, version: waiver.version + 1, ...w };
        return waiver;
      }),
    teeOff: (bookingId: string, carts: string[], signatures: WaiverSignature[]) =>
      reply(() => {
        const b = find(bookingId);
        if (b.status !== "checked_in") throw conflict("not_checked_in", "Check this group in at the pro shop first");
        assignCarts(b, carts, signatures);
        b.status = "teed_off";
        return b;
      }),
    setCarts: (bookingId: string, carts: string[], signatures: WaiverSignature[]) => reply(() => assignCarts(find(bookingId), carts, signatures)),
    noShow: (bookingId: string) => reply(() => Object.assign(find(bookingId), { status: "no_show" as const })),
    cancel: (bookingId: string) => reply(() => Object.assign(find(bookingId), { status: "cancelled" as const })),
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
