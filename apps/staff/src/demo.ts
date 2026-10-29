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
  type EmployeeType,
  type DayClose,
  type CardPayment,
  type CardTerminal,
  type PaymentSettings,
  type ProcessorId,
  type MoneyMethod,
  type Product,
  type Report,
  type ProductInput,
  type Sale,
  type RoundChoice,
  type SaleLineInput,
  type SalePaymentMethod,
  type StockMovement,
  type Punch,
  type Shift,
  type ShiftInput,
  type Swap,
  type SwapAction,
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
import { addDays, todayIn, weekStart } from "./dates";

export const DEMO = process.env.EXPO_PUBLIC_DEMO === "1";
export const DEMO_URL = "demo";

/** The UTC offset River Bend (Chicago) is on for a date, e.g. "-05:00". */
function chicagoOffset(date: string) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((p) => p.type === "timeZoneName")!.value;
  return name.replace("GMT", "") || "+00:00";
}

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
const employeeTypes: Omit<EmployeeType, "staffCount">[] = ["Pro Shop", "Ranger/Starter", "Cart Attendant", "Bartender", "Food & Beverage", "Grounds Crew"].map(
  (name, i) => ({ id: `et-${i + 1}`, name, active: true }),
);
const typeRef = (id: string) => {
  const t = employeeTypes.find((x) => x.id === id)!;
  return { id: t.id, name: t.name };
};
const accounts: (StaffUser & { password: string })[] = [
  { id: "u-1", name: "Morgan Ellis", email: "manager@riverbend.example", role: "manager", employeeType: null, active: true, lastLoginAt: null, password: DEMO_PASSWORD },
  { id: "u-2", name: "Jordan Price", email: "proshop@riverbend.example", role: "staff", employeeType: typeRef("et-1"), active: true, lastLoginAt: null, password: DEMO_PASSWORD },
  { id: "u-3", name: "Sam Torres", email: "starter@riverbend.example", role: "staff", employeeType: typeRef("et-2"), active: true, lastLoginAt: null, password: DEMO_PASSWORD },
  { id: "u-4", name: "Riley Chen", email: "carts@riverbend.example", role: "staff", employeeType: typeRef("et-3"), active: true, lastLoginAt: null, password: DEMO_PASSWORD },
  { id: "u-5", name: "Alex Moreno", email: "bar@riverbend.example", role: "staff", employeeType: typeRef("et-4"), active: true, lastLoginAt: null, password: DEMO_PASSWORD },
];
const activity: ActivityEntry[] = [];
const publicUser = ({ password: _, ...u }: StaffUser & { password: string }): StaffUser => u;

// The demo schedule lives outside the client too, so a swap one person asks for is there when
// the coworker signs in to answer it.
interface DemoShift {
  id: string;
  staffId: string | null;
  typeId: string | null;
  date: string;
  start: string;
  end: string;
  note: string | null;
}
const shifts: DemoShift[] = [];
const punches: (Omit<Punch, "staff" | "hours"> & { staffId: string })[] = [];
const swaps: { id: string; status: Swap["status"]; fromId: string; toId: string; offeredId: string; requestedId: string | null; message: string | null; createdAt: string }[] = [];
const scheduling = { swapsNeedApproval: true };
const opens = new Map<string, NonNullable<DayClose["open"]>>();
const closes = new Map<string, NonNullable<DayClose["close"]>>();
let shiftSeq = 1;

function seedSchedule() {
  if (shifts.length) return;
  const monday = weekStart(todayIn(riverBend.timeZone));
  // Who usually works when: [staff id, type id, start, end, weekdays (0 = Monday)].
  const pattern: [string, string, string, string, number[]][] = [
    ["u-2", "et-1", "06:00", "14:00", [0, 1, 2, 3, 4]],
    ["u-3", "et-2", "06:30", "13:30", [0, 2, 4, 5, 6]],
    ["u-4", "et-3", "07:00", "15:00", [1, 2, 3, 5, 6]],
    ["u-5", "et-4", "15:00", "22:00", [2, 3, 4, 5]],
    ["u-1", "et-1", "09:00", "17:00", [0, 1, 3, 4]],
  ];
  for (const week of [0, 7]) {
    for (const [staffId, typeId, start, end, days] of pattern) {
      for (const d of days) shifts.push({ id: `sh-${shiftSeq++}`, staffId, typeId, date: addDays(monday, week + d), start, end, note: null });
    }
    shifts.push({ id: `sh-${shiftSeq++}`, staffId: null, typeId: "et-4", date: addDays(monday, week + 6), start: "11:00", end: "18:00", note: "Open: Sunday bar" });
  }
}

// The demo pro shop, kept outside the client like the schedule so stock carries between sign-ins.
const products: Product[] = [];
const movements = new Map<string, StockMovement[]>();
const sales: Sale[] = [];
const pos = { salesTaxBps: 725 };

// Card readers: the demo runs on the training simulator with one reader, so the "waiting for
// card" step can be tried. Real courses start on a standalone terminal.
const PROCESSORS: PaymentSettings["providers"] = [
  { id: "standalone", name: "Standalone terminal (record only)", connected: false, fields: [] },
  { id: "simulator", name: "Simulator (training, no real charges)", connected: true, fields: [{ key: "delayMs", label: "Seconds before the card goes through", secret: false, required: false, help: "In milliseconds; 2500 if left empty" }] },
  {
    id: "stripe",
    name: "Stripe Terminal",
    connected: true,
    fields: [
      { key: "secretKey", label: "Secret key", secret: true, required: true, help: "Starts with sk_live_ (or sk_test_ to try it out)" },
      { key: "locationId", label: "Terminal location id", secret: false, required: false, help: "tml_..., to only list this course's readers" },
      { key: "webhookSecret", label: "Webhook signing secret", secret: true, required: false },
    ],
  },
  {
    id: "square",
    name: "Square Terminal",
    connected: true,
    fields: [
      { key: "accessToken", label: "Access token", secret: true, required: true },
      { key: "locationId", label: "Location id", secret: false, required: true },
      { key: "environment", label: "Environment", secret: false, required: false, help: "production, or sandbox to try it out" },
      { key: "webhookSignatureKey", label: "Webhook signature key", secret: true, required: false },
    ],
  },
];
const cardSettings = { provider: "simulator" as ProcessorId, account: {} as Record<string, string>, hasCredentials: false, tipping: false };
const cardTerminals: CardTerminal[] = [{ id: "term-proshop", name: "Pro shop counter", readerId: "sim_proshop", location: "Pro shop", provider: "simulator", active: true }];
const cardPayments = new Map<string, CardPayment & { startedAt: number }>();

function seedProducts() {
  if (products.length) return;
  const list: [string, string, string, number, number, number, number, boolean?][] = [
    // name, sku, category, price, cost, stock, reorder at, taxable
    ["Titleist Pro V1 (dozen)", "TPV1", "Balls", 5499, 3800, 14, 6],
    ["Callaway Supersoft (dozen)", "CSS12", "Balls", 2499, 1550, 22, 8],
    ["Srixon Soft Feel sleeve", "SSF3", "Balls", 999, 560, 4, 6],
    ["FootJoy WeatherSof glove", "FJWS", "Gloves", 2299, 1200, 18, 10],
    ["FootJoy StaSof glove", "FJSS", "Gloves", 2799, 1500, 3, 5],
    ["River Bend logo cap", "RBCAP", "Apparel", 2800, 1100, 25, 8],
    ["River Bend polo", "RBPOLO", "Apparel", 6500, 2800, 11, 6],
    ["Wooden tees (bag of 50)", "TEE50", "Accessories", 399, 120, 40, 15],
    ["Divot tool with ball marker", "DIVOT", "Accessories", 899, 300, 16, 6],
    ["Rain umbrella", "UMB", "Accessories", 3499, 1600, 5, 3],
    ["Bottled water", "H2O", "Food & drink", 250, 60, 48, 24],
    ["Gatorade", "GATR", "Food & drink", 350, 110, 30, 18],
    ["Hot dog", "HOTDOG", "Food & drink", 500, 140, 0, 0, true],
    ["Range bucket, small", "RNGS", "Range", 800, 0, 0, 0, false],
    ["Range bucket, large", "RNGL", "Range", 1400, 0, 0, 0, false],
  ];
  for (const [name, sku, category, priceCents, costCents, stock, reorderLevel, taxable] of list) {
    const tracked = !["Range"].includes(category) && sku !== "HOTDOG";
    products.push({ id: `pr-${sku}`, name, sku, category, priceCents, costCents, taxable: taxable ?? true, trackStock: tracked, stock: tracked ? stock : 0, reorderLevel, low: false, active: true });
  }
  for (const p of products) refreshLow(p);
}
function refreshLow(p: Product) {
  p.low = p.trackStock && p.active && p.stock <= p.reorderLevel;
}

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
  const needAccount = () => {
    const a = account();
    if (!a) throw new ApiError(400, "no_account", "Sign in with your own account to use the time clock and swaps");
    return a;
  };
  const instant = (date: string, time: string) => new Date(`${date}T${time}:00${chicagoOffset(date)}`).toISOString();
  function shiftOut(sh: DemoShift): Shift {
    const staff = sh.staffId ? accounts.find((a) => a.id === sh.staffId) : undefined;
    const type = sh.typeId ? employeeTypes.find((t) => t.id === sh.typeId) : undefined;
    const startsAt = instant(sh.date, sh.start);
    let endsAt = instant(sh.date, sh.end);
    if (endsAt <= startsAt) endsAt = new Date(Date.parse(endsAt) + 86_400_000).toISOString();
    return {
      id: sh.id,
      staff: staff ? { id: staff.id, name: staff.name } : null,
      employeeType: type ? { id: type.id, name: type.name } : null,
      date: sh.date,
      start: sh.start,
      end: sh.end,
      startsAt,
      endsAt,
      hours: Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 360_000) / 10,
      note: sh.note,
    };
  }
  function checkClash(sh: DemoShift, except: string[] = []) {
    if (!sh.staffId) return;
    const a = shiftOut(sh);
    const clash = shifts.some((x) => x.id !== sh.id && !except.includes(x.id) && x.staffId === sh.staffId && (() => {
      const b = shiftOut(x);
      return b.startsAt < a.endsAt && b.endsAt > a.startsAt;
    })());
    if (clash) throw conflict("overlap", "That person already has a shift at that time");
  }
  function clockState() {
    const me = needAccount();
    seedSchedule();
    const open = punches.find((p) => p.staffId === me.id && !p.clockOut);
    const now = new Date().toISOString();
    const next = shifts.filter((x) => x.staffId === me.id).map(shiftOut).filter((x) => x.endsAt > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    return { open: open ? { ...open, staff: { id: me.id, name: me.name }, hours: null } : null, nextShift: next ?? null };
  }
  function swapOut(w: (typeof swaps)[number]): Swap {
    const person = (pid: string) => ({ id: pid, name: accounts.find((a) => a.id === pid)?.name ?? "Someone" });
    const requested = w.requestedId ? shifts.find((x) => x.id === w.requestedId) : undefined;
    return {
      id: w.id,
      status: w.status,
      from: person(w.fromId),
      to: person(w.toId),
      offered: shiftOut(shifts.find((x) => x.id === w.offeredId)!),
      requested: requested ? shiftOut(requested) : null,
      message: w.message,
      createdAt: w.createdAt,
    };
  }
  function applySwap(w: (typeof swaps)[number]) {
    const offered = shifts.find((x) => x.id === w.offeredId)!;
    const requested = w.requestedId ? shifts.find((x) => x.id === w.requestedId) : undefined;
    const ids = [offered.id, ...(requested ? [requested.id] : [])];
    checkClash({ ...offered, staffId: w.toId }, ids);
    if (requested) checkClash({ ...requested, staffId: w.fromId }, ids);
    offered.staffId = w.toId;
    if (requested) requested.staffId = w.fromId;
    w.status = "approved";
  }
  function move(p: Product, change: number, reason: StockMovement["reason"], saleNumber: number | null, note: string | null) {
    p.stock += change;
    refreshLow(p);
    const list = movements.get(p.id) ?? [];
    list.unshift({ id: id(), change, stockAfter: p.stock, reason, saleNumber, note, staff: account()?.name ?? null, at: new Date().toISOString() });
    movements.set(p.id, list);
  }
  function ringUp(input: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod; golferId?: string | null }): Sale {
    if (!input.lines.length) throw new ApiError(400, "empty_sale", "Add something to the sale first");
    const lines = input.lines.map((l) => {
      if ("productId" in l) {
        const p = products.find((x) => x.id === l.productId)!;
        return { productId: p.id, description: p.name, category: p.category, quantity: l.quantity, unitCents: p.priceCents, totalCents: p.priceCents * l.quantity, taxable: p.taxable };
      }
      return { productId: null, description: l.description, category: "Other", quantity: l.quantity, unitCents: l.unitCents, totalCents: l.unitCents * l.quantity, taxable: l.taxable ?? true };
    });
    const subtotalCents = lines.reduce((t, l) => t + l.totalCents, 0);
    const taxCents = input.paymentMethod === "comp" ? 0 : Math.round((lines.filter((l) => l.taxable).reduce((t, l) => t + l.totalCents, 0) * pos.salesTaxBps) / 10_000);
    const g = input.golferId ? golfers.find((x) => x.id === input.golferId) : undefined;
    const sale: Sale = {
      id: id(),
      number: sales.length + 1001,
      at: new Date().toISOString(),
      staff: account()?.name ?? null,
      golfer: g ? { id: g.id, name: g.name } : null,
      subtotalCents,
      taxCents,
      totalCents: subtotalCents + taxCents,
      paymentMethod: input.paymentMethod,
      status: "completed",
      lines,
    };
    sales.unshift(sale);
    for (const l of lines) {
      const p = products.find((x) => x.id === l.productId);
      if (p?.trackStock) move(p, -l.quantity, "sale", sale.number, null);
    }
    log("Made a sale", g?.name);
    return sale;
  }
  function demoClose(date: string): DayClose {
    ensureDay(date);
    const expected: Record<MoneyMethod, number> = { cash: 0, card: 0, gift_card: 0, punch_card: 0, prepaid: 0, comp: 0 };
    for (const b of bookings) if (teeTimes.get(b.teeTimeId)?.date === date) for (const p of b.paid) expected[p.method] += p.amountCents;
    for (const sale of sales)
      if (sale.status === "completed" && new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(sale.at)) === date) expected[sale.paymentMethod] += sale.totalCents;
    return { date, expected, open: opens.get(date) ?? null, close: closes.get(date) ?? null };
  }
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
      return { bookingId: `past-${nextId++}`, startsAt: d.toISOString(), course: riverBend.name, players: 2 + (i % 3), guests: 1 + (i % 3), holes, status: "teed_off" as const, source: "teeitup", paidCents: holes === 18 ? 4200 : 2300 };
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
        return { bookingId: b.id, startsAt: t.startsAt, course: riverBend.name, players: b.players, guests: b.players - 1, holes: b.holes, status: b.status, source: b.source, paidCents: Math.round(payment(b).paidCents / b.players) };
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
        guestsBrought: rounds.reduce((s, h) => s + h.guests, 0),
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
      riding: walkIn.addOns.some((a) => a.code === "gas_cart" && a.quantity > 0),
      resident: walkIn.players.some((p) => p.residency === "resident"),
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
          status: row.status === "no_show" ? "no_show" : "confirmed", source: input.source, totalCents: total, cartNumbers: [], signedCarts: [], riding: false, resident: false,
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
  // The simulator: a card goes through a couple of seconds after it's sent, unless the amount
  // ends in 13 cents, which is declined.
  function cardState(id: string) {
    const p = cardPayments.get(id);
    if (!p) throw new ApiError(404, "not_found", "Card payment not found");
    if (p.status === "processing" && Date.now() - p.startedAt >= Number(cardSettings.account.delayMs || 2500)) {
      Object.assign(
        p,
        p.amountCents % 100 === 13
          ? { status: "failed", failureMessage: "Card declined (simulated)" }
          : { status: "succeeded", cardBrand: "visa", cardLast4: "4242" },
        { completedAt: new Date().toISOString() },
      );
    }
    return p;
  }
  function useCard(id: string) {
    const p = cardState(id);
    if (p.status !== "succeeded") throw conflict("card_not_paid", "The card hasn't gone through on the reader yet");
    if (p.bookingId || p.saleId) throw conflict("card_payment_used", "That card payment has already paid for something else");
    return p;
  }
  const publicCard = ({ startedAt: _s, ...p }: CardPayment & { startedAt: number }): CardPayment => ({ ...p });
  const demoPaymentSettings = (): PaymentSettings => ({
    ...cardSettings,
    connected: PROCESSORS.find((p) => p.id === cardSettings.provider)!.connected,
    currency: "usd",
    providers: PROCESSORS,
  });

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
    checkIn: (bookingId: string, method?: PaymentMethod, items?: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod }, round?: RoundChoice, cardPaymentId?: string) =>
      reply(() => {
        const b = find(bookingId);
        const card = cardPaymentId ? useCard(cardPaymentId) : undefined;
        if (b.status !== "confirmed" && b.status !== "no_show") throw conflict("invalid_status", "This group is already checked in");
        if (round) {
          if (payment(b).paidCents > 0) throw conflict("already_paid", "This group has already paid, so its price can't change here");
          const t = teeTimes.get(b.teeTimeId)!;
          const loops = Math.max(1, Math.round(b.holes / riverBend.holes));
          const fee = quotePlayer(riverBendRates, { residency: round.residency, ageGroup: "adult" }, { startsAt: t.startsAt, timeZone: riverBend.timeZone }, loops).totalCents;
          const cart = round.riding ? riverBendAddOns.find((x) => x.code === "gas_cart")!.priceCents : 0;
          b.totalCents = (fee + cart) * b.players;
          b.resident = round.residency === "resident";
          b.riding = round.riding;
        }
        const balance = payment(b).balanceCents;
        if (balance > 0 && !method) throw conflict("payment_required", "Take payment before checking in");
        if (items?.lines.length) ringUp({ ...items, golferId: b.golferId });
        if (balance > 0 && method) b.paid.push({ amountCents: balance, method });
        b.status = "checked_in";
        if (card) card.bookingId = b.id;
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
    employeeTypes: () =>
      reply(() => {
        managerOnly();
        return [...employeeTypes]
          .sort((a, b) => Number(b.active) - Number(a.active))
          .map((t) => ({ ...t, staffCount: accounts.filter((a) => a.active && a.employeeType?.id === t.id).length }));
      }),
    addEmployeeType: (name: string) =>
      reply(() => {
        managerOnly();
        if (employeeTypes.some((t) => t.active && t.name.toLowerCase() === name.trim().toLowerCase())) throw conflict("type_exists", `There's already a type called ${name.trim()}`);
        const t = { id: id(), name: name.trim(), active: true };
        employeeTypes.push(t);
        log("Added an employee type");
        return { ...t, staffCount: 0 };
      }),
    updateEmployeeType: (typeId: string, patch: { name?: string; active?: boolean }) =>
      reply(() => {
        managerOnly();
        const t = employeeTypes.find((x) => x.id === typeId)!;
        if (patch.name && employeeTypes.some((x) => x.id !== typeId && x.active && x.name.toLowerCase() === patch.name!.trim().toLowerCase())) {
          throw conflict("type_exists", `There's already a type called ${patch.name.trim()}`);
        }
        if (patch.name) t.name = patch.name.trim();
        if (patch.active !== undefined) t.active = patch.active;
        for (const a of accounts) if (a.employeeType?.id === t.id) a.employeeType = { id: t.id, name: t.name };
        log("Changed an employee type");
        return { ...t, staffCount: accounts.filter((a) => a.active && a.employeeType?.id === t.id).length };
      }),
    addStaff: (input: { name: string; email: string; role: Role; password: string; employeeTypeId?: string | null }) =>
      reply(() => {
        managerOnly();
        const email = input.email.trim().toLowerCase();
        if (accounts.some((a) => a.email === email)) throw conflict("email_taken", "Someone here already uses that email");
        if (input.password.length < 8) throw new ApiError(400, "weak_password", "Passwords need at least 8 characters");
        const a = {
          id: id(), name: input.name.trim(), email, role: input.role, active: true, lastLoginAt: null, password: input.password,
          employeeType: input.employeeTypeId ? typeRef(input.employeeTypeId) : null,
        };
        accounts.push(a);
        log("Added a staff account");
        return publicUser(a);
      }),
    updateStaff: (userId: string, patch: { name?: string; role?: Role; active?: boolean; password?: string; employeeTypeId?: string | null }) =>
      reply(() => {
        managerOnly();
        const a = accounts.find((x) => x.id === userId)!;
        if (a.role === "manager" && a.active && (patch.role === "staff" || patch.active === false)) {
          if (a.id === account()?.id) throw conflict("self_demote", "You can't remove your own manager access. Ask another manager");
          if (!accounts.some((x) => x.id !== a.id && x.role === "manager" && x.active)) throw conflict("last_manager", "The course needs at least one active manager");
        }
        if (patch.password !== undefined && patch.password.length < 8) throw new ApiError(400, "weak_password", "Passwords need at least 8 characters");
        const { employeeTypeId, ...rest } = patch;
        if (employeeTypeId !== undefined) {
          if (employeeTypeId && !employeeTypes.find((t) => t.id === employeeTypeId)?.active) throw new ApiError(400, "invalid_employee_type", "Choose one of the course's employee types");
          a.employeeType = employeeTypeId ? typeRef(employeeTypeId) : null;
        }
        Object.assign(a, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
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
    shifts: (from: string, to: string) =>
      reply(() => {
        seedSchedule();
        return shifts.filter((x) => x.date >= from && x.date <= to).map(shiftOut).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      }),
    addShift: (input: ShiftInput) =>
      reply(() => {
        managerOnly();
        const sh: DemoShift = { id: `sh-${shiftSeq++}`, staffId: input.staffUserId ?? null, typeId: input.employeeTypeId ?? null, date: input.date, start: input.start, end: input.end, note: input.note ?? null };
        checkClash(sh);
        shifts.push(sh);
        log("Added a shift");
        return shiftOut(sh);
      }),
    updateShift: (shiftId: string, patch: Partial<ShiftInput>) =>
      reply(() => {
        managerOnly();
        const sh = shifts.find((x) => x.id === shiftId)!;
        const next = {
          ...sh,
          staffId: patch.staffUserId !== undefined ? patch.staffUserId : sh.staffId,
          typeId: patch.employeeTypeId !== undefined ? patch.employeeTypeId : sh.typeId,
          date: patch.date ?? sh.date,
          start: patch.start ?? sh.start,
          end: patch.end ?? sh.end,
          note: patch.note !== undefined ? patch.note : sh.note,
        };
        checkClash(next);
        Object.assign(sh, next);
        for (const w of swaps) if ((w.offeredId === sh.id || w.requestedId === sh.id) && w.status.startsWith("awaiting")) w.status = "cancelled";
        log("Changed a shift");
        return shiftOut(sh);
      }),
    deleteShift: (shiftId: string) =>
      reply(() => {
        managerOnly();
        shifts.splice(shifts.findIndex((x) => x.id === shiftId), 1);
        log("Removed a shift");
        return { ok: true };
      }),
    copyWeek: (from: string, to: string) =>
      reply(() => {
        managerOnly();
        const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
        let copied = 0;
        let skipped = 0;
        for (const sh of shifts.filter((x) => x.date >= from && x.date <= addDays(from, 6))) {
          const copy = { ...sh, id: `sh-${shiftSeq++}`, date: addDays(sh.date, days) };
          try {
            checkClash(copy);
            shifts.push(copy);
            copied++;
          } catch {
            skipped++;
          }
        }
        log("Copied a week of shifts");
        return { copied, skipped };
      }),
    clock: () => reply(() => clockState()),
    clockIn: () =>
      reply(() => {
        const me = needAccount();
        if (punches.some((x) => x.staffId === me.id && !x.clockOut)) throw conflict("already_clocked_in", "You're already clocked in");
        punches.push({ id: id(), staffId: me.id, shiftId: clockState().nextShift?.id ?? null, clockIn: new Date().toISOString(), clockOut: null, edited: false });
        log("Clocked in");
        return clockState();
      }),
    clockOut: () =>
      reply(() => {
        const me = needAccount();
        const open = punches.find((x) => x.staffId === me.id && !x.clockOut);
        if (!open) throw conflict("not_clocked_in", "You aren't clocked in");
        open.clockOut = new Date().toISOString();
        log("Clocked out");
        return clockState();
      }),
    timesheets: (from: string, to: string) =>
      reply(() => {
        managerOnly();
        seedSchedule();
        return accounts
          .filter((a) => a.active)
          .map((a) => {
            const scheduled = shifts.filter((x) => x.staffId === a.id && x.date >= from && x.date <= to).map(shiftOut);
            // Pretend everyone worked their past shifts, so the demo timesheet has numbers in it.
            const worked: Punch[] = scheduled
              .filter((x) => x.endsAt < new Date().toISOString())
              .map((x) => ({ id: `p-${x.id}`, staff: { id: a.id, name: a.name }, shiftId: x.id, clockIn: x.startsAt, clockOut: x.endsAt, hours: x.hours, edited: false }));
            const live = punches
              .filter((p) => p.staffId === a.id)
              .map((p) => ({ ...p, staff: { id: a.id, name: a.name }, hours: p.clockOut ? Math.round((Date.parse(p.clockOut) - Date.parse(p.clockIn)) / 360_000) / 10 : null }));
            const all = [...worked, ...live];
            return {
              staff: { id: a.id, name: a.name },
              scheduledHours: Math.round(scheduled.reduce((t, x) => t + x.hours, 0) * 10) / 10,
              workedHours: Math.round(all.reduce((t, p) => t + (p.hours ?? 0), 0) * 10) / 10,
              open: live.some((p) => !p.clockOut),
              punches: all,
            };
          })
          .filter((t) => t.punches.length || t.scheduledHours);
      }),
    swaps: () =>
      reply(() => {
        const me = account();
        return swaps.filter((w) => w.fromId === me?.id || w.toId === me?.id || (role() === "manager" && w.status === "awaiting_manager")).map(swapOut);
      }),
    askSwap: (input: { offeredShiftId: string; toUserId: string; requestedShiftId?: string | null; message?: string | null }) =>
      reply(() => {
        const me = needAccount();
        const offered = shifts.find((x) => x.id === input.offeredShiftId)!;
        if (offered.staffId !== me.id) throw new ApiError(400, "not_your_shift", "You can only swap your own shifts");
        if (swaps.some((w) => w.offeredId === offered.id && w.status.startsWith("awaiting"))) throw conflict("swap_pending", "There's already a request open for this shift");
        const w = { id: id(), status: "awaiting_coworker" as const, fromId: me.id, toId: input.toUserId, offeredId: offered.id, requestedId: input.requestedShiftId ?? null, message: input.message ?? null, createdAt: new Date().toISOString() };
        swaps.unshift(w);
        log("Asked to swap a shift");
        return swapOut(w);
      }),
    answerSwap: (swapId: string, action: SwapAction) =>
      reply(() => {
        const w = swaps.find((x) => x.id === swapId)!;
        const me = account();
        if (!w.status.startsWith("awaiting")) throw conflict("swap_closed", "This request has already been answered");
        if (action === "cancel") {
          if (w.fromId !== me?.id) throw new ApiError(403, "not_yours", "Only the person who asked can cancel");
          w.status = "cancelled";
        } else if (action === "accept" || action === "decline") {
          if (w.toId !== me?.id) throw new ApiError(403, "not_yours", "Only the coworker who was asked can answer");
          if (action === "decline") w.status = "declined";
          else if (scheduling.swapsNeedApproval) w.status = "awaiting_manager";
          else applySwap(w);
        } else {
          managerOnly();
          if (w.status !== "awaiting_manager") throw conflict("awaiting_coworker", "The coworker hasn't accepted yet");
          if (action === "reject") w.status = "rejected";
          else applySwap(w);
        }
        log("Answered a shift swap");
        return swapOut(w);
      }),
    coworkers: () =>
      reply(() => accounts.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, employeeType: a.employeeType?.name ?? null }))),
    schedulingSettings: () => reply(() => ({ ...scheduling })),
    saveSchedulingSettings: (next: { swapsNeedApproval: boolean }) =>
      reply(() => {
        managerOnly();
        scheduling.swapsNeedApproval = next.swapsNeedApproval;
        log("Changed scheduling settings");
        return { ...scheduling };
      }),
    products: (opts: { q?: string; all?: boolean } = {}) =>
      reply(() => {
        seedProducts();
        const q = opts.q?.trim().toLowerCase() ?? "";
        return products
          .filter((p) => (opts.all || p.active) && (!q || p.name.toLowerCase().includes(q) || p.sku?.toLowerCase() === q))
          .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
          .map((p) => ({ ...p }));
      }),
    addProduct: (input: ProductInput) =>
      reply(() => {
        managerOnly();
        seedProducts();
        if (input.sku && products.some((p) => p.sku?.toLowerCase() === input.sku!.toLowerCase())) throw conflict("sku_taken", "Another product already uses that SKU");
        const p: Product = {
          id: id(),
          name: input.name.trim(),
          sku: input.sku?.trim() || null,
          category: input.category?.trim() || "Other",
          priceCents: input.priceCents,
          costCents: input.costCents ?? null,
          taxable: input.taxable ?? true,
          trackStock: input.trackStock ?? true,
          stock: input.trackStock === false ? 0 : (input.stock ?? 0),
          reorderLevel: input.reorderLevel ?? 0,
          low: false,
          active: true,
        };
        refreshLow(p);
        products.push(p);
        if (p.stock) move(p, p.stock, "receive", null, "Starting stock");
        log("Added a product");
        return { ...p };
      }),
    updateProduct: (productId: string, patch: Partial<Omit<ProductInput, "stock">> & { active?: boolean }) =>
      reply(() => {
        managerOnly();
        const p = products.find((x) => x.id === productId)!;
        if (patch.sku && products.some((x) => x.id !== p.id && x.sku?.toLowerCase() === patch.sku!.toLowerCase())) throw conflict("sku_taken", "Another product already uses that SKU");
        Object.assign(p, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
        refreshLow(p);
        log("Changed a product");
        return { ...p };
      }),
    productHistory: (productId: string) => reply(() => movements.get(productId) ?? []),
    changeStock: (productId: string, change: { kind: "receive" | "count" | "adjust"; quantity: number; note?: string | null }) =>
      reply(() => {
        if (change.kind !== "receive") managerOnly();
        if (change.kind === "adjust" && !change.note?.trim()) throw new ApiError(400, "note_required", "Say why the stock is being adjusted");
        const p = products.find((x) => x.id === productId)!;
        const after = change.kind === "count" ? change.quantity : p.stock + change.quantity;
        move(p, after - p.stock, change.kind, null, change.note?.trim() || null);
        log("Changed stock");
        return { ...p };
      }),
    sell: (input: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod; golferId?: string | null; cardPaymentId?: string }) =>
      reply(() => {
        const card = input.cardPaymentId ? useCard(input.cardPaymentId) : undefined;
        const sale = ringUp(input);
        if (card) card.saleId = sale.id;
        return sale;
      }),
    sales: (date: string) =>
      reply(() => {
        const list = sales.filter((x) => new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(x.at)) === date);
        const kept = list.filter((x) => x.status === "completed");
        const sum = (l: { totalCents: number }[]) => l.reduce((t, x) => t + x.totalCents, 0);
        const byMethod: Partial<Record<SalePaymentMethod, number>> = {};
        for (const x of kept) byMethod[x.paymentMethod] = (byMethod[x.paymentMethod] ?? 0) + x.totalCents;
        const byCategory: Record<string, number> = {};
        for (const l of kept.flatMap((x) => x.lines)) byCategory[l.category] = (byCategory[l.category] ?? 0) + l.totalCents;
        return {
          sales: list,
          summary: {
            count: kept.length,
            subtotalCents: kept.reduce((t, x) => t + x.subtotalCents, 0),
            taxCents: kept.reduce((t, x) => t + x.taxCents, 0),
            totalCents: sum(kept),
            refundedCents: sum(list.filter((x) => x.status === "refunded")),
            byMethod,
            byCategory,
          },
        };
      }),
    refundSale: (saleId: string) =>
      reply(() => {
        managerOnly();
        const sale = sales.find((x) => x.id === saleId)!;
        if (sale.status === "refunded") throw conflict("already_refunded", "This sale was already refunded");
        sale.status = "refunded";
        for (const l of sale.lines) {
          const p = products.find((x) => x.id === l.productId);
          if (p?.trackStock) move(p, l.quantity, "refund", sale.number, null);
        }
        log("Refunded a sale", sale.golfer?.name);
        return sale;
      }),
    report: (from: string, to: string) =>
      reply((): Report => {
        managerOnly();
        const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(iso));
        const inRange = (d: string) => d >= from && d <= to;
        type Day = Report["days"][number];
        const days = new Map<string, Day>();
        const at = (date: string) => {
          if (!days.has(date)) days.set(date, { date, greenFeesCents: 0, cartsAndExtrasCents: 0, proShopCents: 0, taxCents: 0, collectedCents: 0, rounds: 0 });
          return days.get(date)!;
        };
        const collected: Record<MoneyMethod, number> = { cash: 0, card: 0, gift_card: 0, punch_card: 0, prepaid: 0, comp: 0 };
        const bySource: Record<string, number> = {};
        let played = 0;
        let booked = 0;
        let noShows = 0;
        for (const b of bookings) {
          const t = teeTimes.get(b.teeTimeId)!;
          if (b.status === "cancelled" || !inRange(t.date)) continue;
          if (b.status === "no_show") {
            noShows += b.players;
            continue;
          }
          booked += b.players;
          bySource[b.source] = (bySource[b.source] ?? 0) + b.players;
          const d = at(t.date);
          // The demo doesn't keep booking lines, so carts are worked out from whether the group rides.
          const carts = b.riding ? Math.min(b.totalCents, b.players * 1300) : 0;
          d.cartsAndExtrasCents += carts;
          d.greenFeesCents += b.totalCents - carts;
          if (b.status === "checked_in" || b.status === "teed_off") {
            d.rounds += b.players;
            played += b.players;
          }
          // Demo payments are counted on the day of the round.
          for (const p of b.paid) {
            d.collectedCents += p.amountCents;
            collected[p.method] += p.amountCents;
          }
        }
        const kept = sales.filter((x) => inRange(dayOf(x.at)));
        const categories = new Map<string, { category: string; cents: number; items: number }>();
        for (const sale of kept.filter((x) => x.status === "completed")) {
          const d = at(dayOf(sale.at));
          d.proShopCents += sale.subtotalCents;
          d.taxCents += sale.taxCents;
          d.collectedCents += sale.totalCents;
          collected[sale.paymentMethod] += sale.totalCents;
          for (const l of sale.lines) {
            const c = categories.get(l.category) ?? { category: l.category, cents: 0, items: 0 };
            c.cents += l.totalCents;
            c.items += l.quantity;
            categories.set(l.category, c);
          }
        }
        const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
        const sum = (k: keyof Omit<Day, "date">) => list.reduce((t, d) => t + d[k], 0);
        const spots = [...teeTimes.values()].filter((t) => inRange(t.date) && t.status === "open").reduce((t, x) => t + x.maxPlayers, 0);
        const worked = punches.filter((p) => p.clockOut && inRange(dayOf(p.clockIn)));
        return {
          from,
          to,
          revenue: {
            greenFeesCents: sum("greenFeesCents"),
            cartsAndExtrasCents: sum("cartsAndExtrasCents"),
            proShopCents: sum("proShopCents"),
            totalCents: sum("greenFeesCents") + sum("cartsAndExtrasCents") + sum("proShopCents"),
            salesTaxCents: sum("taxCents"),
            proShopRefundsCents: kept.filter((x) => x.status === "refunded").reduce((t, x) => t + x.totalCents, 0),
            proShopByCategory: [...categories.values()].sort((a, b) => b.cents - a.cents),
          },
          collected: { ...collected, totalCents: Object.values(collected).reduce((t, c) => t + c, 0) },
          rounds: { played, booked, noShows, openSpots: spots, occupancy: spots ? Math.round((booked / spots) * 1000) / 10 : null, bySource },
          labor: {
            hours: Math.round(worked.reduce((t, p) => t + (Date.parse(p.clockOut!) - Date.parse(p.clockIn)) / 3_600_000, 0) * 10) / 10,
            people: new Set(worked.map((p) => p.staffId)).size,
          },
          days: list,
        };
      }),
    dayClose: (date: string) => reply(() => demoClose(date)),
    openDay: (date: string, input: { startingCashCents: number }) =>
      reply(() => {
        if (closes.has(date)) throw conflict("already_closed", "This day is already closed");
        if (opens.has(date) && role() !== "manager") throw conflict("already_opened", "The starting cash is already in. Ask a manager to change it");
        opens.set(date, { startingCashCents: input.startingCashCents, openedBy: account()?.name ?? null, openedAt: new Date().toISOString() });
        log("Entered the starting cash");
        return demoClose(date);
      }),
    closeDay: (date: string, input: { countedCashCents: number; note?: string | null }) =>
      reply(() => {
        const expected = demoClose(date).expected;
        const start = opens.get(date);
        if (!start) throw conflict("not_opened", "Enter the starting cash for this day first");
        if (closes.has(date) && role() !== "manager") throw conflict("already_closed", "This day is already closed. Ask a manager to close it again");
        const overShortCents = input.countedCashCents - start.startingCashCents - expected.cash;
        if (overShortCents !== 0 && !input.note?.trim()) throw new ApiError(400, "note_required", "The drawer is over or short. Add a note saying why");
        closes.set(date, {
          startingCashCents: start.startingCashCents,
          cashTakenCents: expected.cash,
          expectedCashCents: start.startingCashCents + expected.cash,
          countedCashCents: input.countedCashCents,
          overShortCents,
          note: input.note?.trim() || null,
          closedBy: account()?.name ?? null,
          closedAt: new Date().toISOString(),
        });
        log("Closed the day");
        return demoClose(date);
      }),
    posSettings: () => reply(() => ({ ...pos })),
    savePosSettings: (next: { salesTaxBps: number }) =>
      reply(() => {
        managerOnly();
        pos.salesTaxBps = next.salesTaxBps;
        log("Changed sales tax");
        return { ...pos };
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
    undoNoShow: (bookingId: string) =>
      reply(() => {
        const b = find(bookingId);
        if (b.status !== "no_show") throw conflict("invalid_status", "This group isn't marked as a no-show");
        log("Undid a no-show", b.customerName);
        return Object.assign(b, { status: "confirmed" as const });
      }),
    cancel: (bookingId: string) =>
      reply(() => {
        if (find(bookingId).status !== "confirmed" && find(bookingId).status !== "no_show") throw conflict("invalid_status", "Only groups that haven't checked in can be removed");
        log("Cancelled a booking", find(bookingId).customerName);
        return Object.assign(find(bookingId), { status: "cancelled" as const });
      }),
    removePlayers: (bookingId: string, count: number) =>
      reply(() => {
        const b = find(bookingId);
        if (b.status !== "confirmed" && b.status !== "no_show") throw conflict("invalid_status", "Only groups that haven't checked in can lose players");
        if (count >= b.players) throw new ApiError(400, "whole_group", "To take everyone off, remove the whole group");
        const total = Math.round((b.totalCents * (b.players - count)) / b.players);
        if (b.payment.paidCents > total) throw conflict("already_paid", "They've already paid for those players. Refund them first");
        b.players -= count;
        b.totalCents = total;
        b.payment = payment(b);
        log(`Removed ${count} player${count === 1 ? "" : "s"}`, b.customerName);
        return b;
      }),
    addGuests: (bookingId: string, g: { count: number; riding: boolean; residency?: "resident" | "nonresident" }) =>
      reply(() => {
        const b = find(bookingId);
        const t = teeTimes.get(b.teeTimeId)!;
        const left = t.maxPlayers - live(t.id).reduce((s, x) => s + x.players, 0);
        if (g.count > left) throw conflict("not_enough_spots", `Only ${left} spot${left === 1 ? "" : "s"} left`);
        const loops = Math.max(1, Math.round(b.holes / riverBend.holes));
        const player = { residency: g.residency ?? "nonresident", ageGroup: "adult" } as const;
        const each = quotePlayer(riverBendRates, player, { startsAt: t.startsAt, timeZone: riverBend.timeZone }, loops).totalCents + (g.riding ? riverBendAddOns.find((x) => x.code === "gas_cart")!.priceCents : 0);
        b.players += g.count;
        b.totalCents += each * g.count;
        if (g.riding) b.riding = true;
        b.payment = payment(b);
        log(`Added ${g.count} guest${g.count === 1 ? "" : "s"}`, b.customerName);
        return b;
      }),
    paymentSettings: () => reply(demoPaymentSettings),
    savePaymentSettings: (input: { provider: ProcessorId; account?: Record<string, string>; credentials?: Record<string, string>; tipping?: boolean }) =>
      reply(() => {
        managerOnly();
        const p = PROCESSORS.find((x) => x.id === input.provider)!;
        const switching = p.id !== cardSettings.provider;
        for (const f of p.fields.filter((x) => x.required)) {
          const have = f.secret ? input.credentials?.[f.key] || (!switching && cardSettings.hasCredentials) : input.account?.[f.key];
          if (!have) throw new ApiError(400, "missing_field", `Enter the ${f.label.toLowerCase()} for ${p.name}`);
        }
        Object.assign(cardSettings, {
          provider: p.id,
          account: { ...(input.account ?? {}) },
          hasCredentials: !!Object.keys(input.credentials ?? {}).length || (!switching && cardSettings.hasCredentials),
          tipping: input.tipping ?? cardSettings.tipping,
        });
        log("Changed card payment settings");
        return demoPaymentSettings();
      }),
    discoverReaders: () =>
      reply(() => {
        managerOnly();
        if (cardSettings.provider !== "simulator") throw new ApiError(502, "processor_auth", "The demo can't reach a real processor. Use the simulator");
        return [
          { readerId: "sim_proshop", label: "Simulated reader 1", online: true },
          { readerId: "sim_bar", label: "Simulated reader 2", online: true },
        ];
      }),
    terminals: () => reply(() => cardTerminals.filter((t) => t.provider === cardSettings.provider).map((t) => ({ ...t }))),
    addTerminal: (input: { name: string; readerId: string; location?: string | null }) =>
      reply(() => {
        managerOnly();
        if (!input.name.trim() || !input.readerId.trim()) throw new ApiError(400, "invalid_request", "Enter the reader's id and a name");
        if (cardTerminals.some((t) => t.provider === cardSettings.provider && t.readerId === input.readerId.trim())) throw conflict("reader_taken", "That reader is already added");
        const t: CardTerminal = { id: id(), name: input.name.trim(), readerId: input.readerId.trim(), location: input.location?.trim() || null, provider: cardSettings.provider, active: true };
        cardTerminals.push(t);
        log("Added a card reader", t.name);
        return t;
      }),
    updateTerminal: (terminalId: string, patch: { name?: string; location?: string | null; active?: boolean }) =>
      reply(() => {
        managerOnly();
        const t = cardTerminals.find((x) => x.id === terminalId);
        if (!t) throw new ApiError(404, "not_found", "Card reader not found");
        Object.assign(t, patch);
        return { ...t };
      }),
    startCardPayment: (input: { terminalId: string; amountCents: number; description?: string }) =>
      reply(() => {
        const t = cardTerminals.find((x) => x.id === input.terminalId && x.active);
        if (!t) throw new ApiError(400, "reader_unavailable", "That card reader isn't set up any more. Pick another in Settings");
        const p = {
          id: id(), terminalId: t.id, terminal: t.name, amountCents: input.amountCents, tipCents: 0, status: "processing" as const, failureMessage: null,
          cardBrand: null, cardLast4: null, refundedCents: 0, bookingId: null, saleId: null, createdAt: new Date().toISOString(), completedAt: null, startedAt: Date.now(),
        };
        cardPayments.set(p.id, p);
        return publicCard(p);
      }),
    cardPayment: (paymentId: string) => reply(() => publicCard(cardState(paymentId))),
    cancelCardPayment: (paymentId: string) =>
      reply(() => {
        const p = cardState(paymentId);
        if (p.status === "processing") Object.assign(p, { status: "cancelled", completedAt: new Date().toISOString() });
        return publicCard(p);
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
