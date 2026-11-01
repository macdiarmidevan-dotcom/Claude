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
  type AccountingFormat,
  type AudiencePreview,
  type Campaign,
  type CampaignDetail,
  type MessageAudience,
  type MessageChannel,
  type MessageKind,
  type MessageSettings,
  type SentMessage,
  type Asset,
  type AssetDetail,
  type AssetInput,
  type AssetKind,
  type AssetPower,
  type WorkOrder,
  type WorkOrderArea,
  type WorkOrderDetail,
  type WorkOrderInput,
  type WorkOrderStatus,
  type AccountingSettings,
  type AccountKey,
  type Journal,
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
  type GolferPass,
  type LoyaltySettings,
  type PassType,
  type StatementDetail,
  type AccountEntry,
  type GiftCard,
  type GiftCardDetail,
  type GiftCardMethod,
  type HouseAccount,
  type HouseAccountDetail,
  type Statement,
  type PrepStation,
  type PrepTicket,
  type Tab,
  type TabItem,
  type TabItemInput,
  type TabLocation,
  type NewEvent,
  type EventPaymentMethod,
  type StandingTime,
  type HoldConflict,
  type EventSummary,
  type EventDetail,
  type EventDay,
  type Redemption,
  type RainCheck,
  type Wallet,
  type SheetBooking,
  type SheetTeeTime,
  type Waiver,
  type WaiverSignature,
  type WalkIn,
} from "./api";
import { addDays, todayIn, weekStart } from "./dates";
import { formatTime, money } from "./theme";

export const DEMO = process.env.EXPO_PUBLIC_DEMO === "1";
export const DEMO_URL = "demo";

/** The UTC offset River Bend (Chicago) is on for a date, e.g. "-05:00". */
function chicagoOffset(date: string) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((p) => p.type === "timeZoneName")!.value;
  return name.replace("GMT", "") || "+00:00";
}

interface DemoBooking extends Omit<SheetBooking, "greenFeeCents" | "cartCents"> {
  paid: { amountCents: number; method: PaymentMethod }[];
  /** The round's price before any rain check or refund came off it. */
  originalCents?: number;
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
    ["Bottled water", "H2O", "Drinks", 250, 60, 48, 24],
    ["Gatorade", "GATR", "Drinks", 350, 110, 30, 18],
    ["Domestic beer, can", "CAN", "Beer", 500, 140, 96, 48],
    ["Draft beer", "DRAFT", "Beer", 600, 150, 0, 0],
    ["Bloody Mary", "BMARY", "Cocktails", 900, 220, 0, 0],
    ["Coffee", "COFFEE", "Drinks", 250, 40, 0, 0],
    ["Hot dog", "HOTDOG", "Grill", 500, 140, 0, 0],
    ["Turn burger", "BURGER", "Grill", 900, 310, 0, 0],
    ["Chicken wrap", "WRAP", "Grill", 1000, 330, 0, 0],
    ["Breakfast sandwich", "BKFST", "Grill", 650, 190, 0, 0],
    ["Range bucket, small", "RNGS", "Range", 800, 0, 0, 0, false],
    ["Range bucket, large", "RNGL", "Range", 1400, 0, 0, 0, false],
  ];
  for (const [name, sku, category, priceCents, costCents, stock, reorderLevel, taxable] of list) {
    // Made-to-order food and poured drinks go to a prep screen and have no shelf count.
    const station = category === "Grill" ? "kitchen" : ["DRAFT", "BMARY", "COFFEE"].includes(sku) ? "bar" : null;
    const foodBev = !!station || ["Drinks", "Beer"].includes(category);
    const tracked = !["Range"].includes(category) && !station;
    products.push({ id: `pr-${sku}`, name, sku, category, priceCents, costCents, taxable: taxable ?? true, trackStock: tracked, stock: tracked ? stock : 0, reorderLevel, foodBev, station, low: false, active: true });
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
  type RingLine = SaleLineInput | { productId: string; quantity: number; unitCents: number } | { description: string; unitCents: number; quantity: number; taxable: boolean; category: string; foodBev: boolean };
  function ringUp(input: { lines: RingLine[]; paymentMethod: SalePaymentMethod; golferId?: string | null; giftCardCode?: string | null }): Sale {
    if (!input.lines.length) throw new ApiError(400, "empty_sale", "Add something to the sale first");
    const lines = input.lines.map((l) => {
      if ("productId" in l) {
        const p = products.find((x) => x.id === l.productId)!;
        const unit = "unitCents" in l ? l.unitCents : p.priceCents;
        return { productId: p.id, description: p.name, category: p.category, quantity: l.quantity, unitCents: unit, totalCents: unit * l.quantity, taxable: p.taxable, foodBev: p.foodBev };
      }
      const extra = "foodBev" in l ? { category: l.category, foodBev: l.foodBev } : { category: "Other", foodBev: false };
      return { productId: null, description: l.description, quantity: l.quantity, unitCents: l.unitCents, totalCents: l.unitCents * l.quantity, taxable: l.taxable ?? true, ...extra };
    });
    const subtotalCents = lines.reduce((t, l) => t + l.totalCents, 0);
    const taxCents = input.paymentMethod === "comp" ? 0 : Math.round((lines.filter((l) => l.taxable).reduce((t, l) => t + l.totalCents, 0) * pos.salesTaxBps) / 10_000);
    const g = input.golferId ? golfers.find((x) => x.id === input.golferId) : undefined;
    const number = sales.length + 1001;
    if (input.paymentMethod === "gift_card" && input.giftCardCode) spendGift(input.giftCardCode, subtotalCents + taxCents, { saleNumber: number });
    if (input.paymentMethod === "house_account")
      chargeHouse(input.golferId, subtotalCents + taxCents, `Sale #${number}: ${lines.map((l) => (l.quantity > 1 ? `${l.quantity} × ${l.description}` : l.description)).join(", ")}`, { saleNumber: number });
    const sale: Sale = {
      id: id(),
      number,
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
    const expected: Record<MoneyMethod, number> = { cash: 0, card: 0, gift_card: 0, punch_card: 0, season_pass: 0, loyalty: 0, rain_check: 0, check: 0, house_account: 0, prepaid: 0, comp: 0 };
    for (const b of bookings) if (teeTimes.get(b.teeTimeId)?.date === date) for (const p of b.paid) expected[p.method] += p.amountCents;
    for (const sale of sales)
      if (sale.status === "completed" && new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(sale.at)) === date) expected[sale.paymentMethod] += sale.totalCents;
    for (const ev of events)
      for (const p of ev.payments) if (p.method !== "comp" && new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(p.at)) === date) expected[p.method] += p.amountCents;
    for (const h of heldMoney((iso) => new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(iso)), (d) => d === date)) expected[h.method] += h.cents;
    return { date, expected, close: closes.get(date) ?? null };
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

  const cartPrice = riverBendAddOns.find((x) => x.code === "gas_cart")!.priceCents;
  // The demo keeps one total per booking; carts are one per rider, the rest is green fees.
  function fees(b: Pick<DemoBooking, "totalCents" | "riding" | "players">) {
    const cartCents = b.riding ? Math.min(b.totalCents, b.players * cartPrice) : 0;
    return { greenFeeCents: b.totalCents - cartCents, cartCents };
  }

  // Punch cards, season passes and loyalty points.
  const passTypes: PassType[] = [
    { id: "pt-10", name: "10-round punch card", kind: "punch_card", priceCents: 26000, rounds: 10, validDays: 365, coversCart: false, active: true },
    { id: "pt-10r", name: "10-round punch card with cart", kind: "punch_card", priceCents: 38000, rounds: 10, validDays: 365, coversCart: true, active: true },
    { id: "pt-season", name: "Season pass", kind: "season_pass", priceCents: 89500, rounds: null, validDays: 240, coversCart: false, active: true },
  ];
  const loyalty: LoyaltySettings = { pointsPerDollar: 1, rewardPoints: 100, rewardCents: 500 };
  const golferPasses: (Omit<GolferPass, "roundsLeft" | "usable"> & { golferId: string })[] = [];
  const points = new Map<string, number>();
  const pointsLog: (Wallet["loyalty"]["history"][number] & { golferId: string })[] = [];
  function changePoints(golferId: string, change: number, reason: Wallet["loyalty"]["history"][number]["reason"], note: string | null = null) {
    const before = points.get(golferId) ?? 0;
    const after = Math.max(0, before + change);
    if (after === before) return;
    points.set(golferId, after);
    pointsLog.unshift({ golferId, change: after - before, balanceAfter: after, reason, note, staff: account()?.name ?? null, at: new Date().toISOString() });
  }
  const earn = (golferId: string | null | undefined, cents: number, reason: "round" | "sale") => {
    if (golferId && loyalty.pointsPerDollar > 0) changePoints(golferId, Math.floor(cents / 100) * loyalty.pointsPerDollar, reason);
  };
  const rainChecks: RainCheck[] = [];
  const rainCheckSettings = { rainCheckDays: 365 };
  const rcView = (r: RainCheck): RainCheck => ({ ...r, usable: r.status === "active" && r.remainingCents > 0 && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now()) });
  const RC_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rcCode = () => "RC-" + Array.from({ length: 6 }, () => RC_CHARS[Math.floor(Math.random() * RC_CHARS.length)]).join("");
  function roundMoney(b: DemoBooking) {
    if (b.status !== "checked_in" && b.status !== "teed_off") throw conflict("invalid_status", "Only groups that have checked in can get a rain check or refund");
    const f = fees({ ...b, totalCents: b.originalCents ?? b.totalCents });
    return { green: f.greenFeeCents, carts: f.cartCents, givable: Math.min(b.totalCents, payment(b).paidCents) };
  }
  function useRainCheck(b: DemoBooking, code: string) {
    const r = rainChecks.find((x) => x.code === code.trim().toUpperCase());
    if (!r) throw new ApiError(404, "not_found", "Rain check not found");
    if (!rcView(r).usable) throw conflict("rain_check_unusable", r.status === "void" ? "That rain check was voided" : r.remainingCents === 0 ? "That rain check has been used up" : "That rain check has expired");
    if (r.bookingId === b.id) throw new ApiError(400, "same_round", "A rain check is for a later round");
    const amount = Math.min(r.remainingCents, payment(b).balanceCents);
    if (amount <= 0) return;
    r.remainingCents -= amount;
    b.paid.push({ amountCents: amount, method: "rain_check" });
  }

  function passView(p: (typeof golferPasses)[number]): GolferPass {
    const { golferId: _, ...rest } = p;
    const roundsLeft = p.roundsTotal === null ? null : p.roundsTotal - p.roundsUsed;
    const expired = !!p.expiresAt && Date.parse(p.expiresAt) <= Date.now();
    return { ...rest, roundsLeft, usable: p.status === "active" && !expired && (roundsLeft === null || roundsLeft > 0) };
  }
  function wallet(golferId: string): Wallet {
    if (!golfers.some((g) => g.id === golferId)) throw new ApiError(404, "not_found", "Golfer account not found");
    const pts = points.get(golferId) ?? 0;
    return {
      passes: golferPasses.filter((p) => p.golferId === golferId).map(passView),
      rainChecks: rainChecks.filter((r) => r.golferId === golferId).map(rcView),
      giftCards: giftCards.filter((g) => g.golferId === golferId && g.status === "active" && g.balanceCents > 0).map(gcView),
      houseAccount: (() => {
        const a = houseAccounts.find((x) => x.golferId === golferId);
        return a ? accountView(a) : null;
      })(),
      loyalty: {
        ...loyalty,
        enabled: loyalty.pointsPerDollar > 0,
        points: pts,
        rewardsAvailable: Math.floor(pts / loyalty.rewardPoints),
        history: pointsLog.filter((l) => l.golferId === golferId).slice(0, 30).map(({ golferId: _, ...l }) => l),
      },
    };
  }
  function redeem(b: DemoBooking, r: Redemption) {
    if (!b.golferId) throw new ApiError(400, "no_account", "Link the golfer's account to use their passes or points");
    if (r.pass) {
      const p = golferPasses.find((x) => x.id === r.pass!.golferPassId);
      if (!p || p.golferId !== b.golferId) throw new ApiError(400, "not_their_pass", "That pass is on someone else's account");
      const v = passView(p);
      if (!v.usable) throw conflict("pass_unusable", "That pass can't be used today");
      if (r.pass.rounds > b.players) throw new ApiError(400, "too_many_rounds", `This group only has ${b.players} players`);
      if (v.roundsLeft !== null && r.pass.rounds > v.roundsLeft) throw conflict("not_enough_rounds", `Only ${v.roundsLeft} rounds left on the card`);
      if (p.kind === "season_pass" && r.pass.rounds !== 1) throw new ApiError(400, "season_pass_holder_only", "A season pass covers the holder only");
      const f = fees(b);
      const perPlayer = f.greenFeeCents / b.players + (p.coversCart ? f.cartCents / b.players : 0);
      const covered = Math.min(payment(b).balanceCents, Math.round(perPlayer * r.pass.rounds));
      if (p.kind === "punch_card") p.roundsUsed += r.pass.rounds;
      if (covered > 0) b.paid.push({ amountCents: covered, method: p.kind });
    }
    if (r.points) {
      if (r.points % loyalty.rewardPoints !== 0) throw new ApiError(400, "whole_rewards", `Points are used ${loyalty.rewardPoints} at a time`);
      const have = points.get(b.golferId) ?? 0;
      if (have < r.points) throw conflict("not_enough_points", `The golfer only has ${have} points`);
      const value = (r.points / loyalty.rewardPoints) * loyalty.rewardCents;
      if (value > payment(b).balanceCents) throw new ApiError(400, "too_many_points", "That's more off than the round costs. Use fewer points");
      changePoints(b.golferId, -r.points, "redeem");
      if (value > 0) b.paid.push({ amountCents: value, method: "loyalty" });
    }
  }

  const earnSale = (sale: Sale) => {
    if (sale.paymentMethod !== "comp") earn(sale.golfer?.id, sale.totalCents, "sale");
  };

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
    // Linda plays on a punch card and has points saved up, so checkout shows both.
    const linda = golfers.find((g) => g.name === "Linda Hart")!.id;
    golferPasses.push({
      id: id(), golferId: linda, name: "10-round punch card", kind: "punch_card", roundsTotal: 10, roundsUsed: 3, coversCart: false,
      expiresAt: new Date(Date.now() + 300 * 86_400_000).toISOString(), soldAt: new Date(Date.now() - 65 * 86_400_000).toISOString(), status: "active",
    });
    changePoints(linda, 340, "round");
    // And a rain check from a round last week that lightning cut short.
    rainChecks.push({
      id: id(), code: "RC-7K2M9Q", bookingId: "past-rain", golferId: linda, name: "Linda Hart", players: 1, holesUnplayed: 5, amountCents: 1300, remainingCents: 1300,
      expiresAt: new Date(Date.now() + 358 * 86_400_000).toISOString(), status: "active", note: "Lightning", issuedBy: "Jordan Price",
      issuedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(), usable: true,
    });
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
    seedAccounts();
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

  // The cart fleet, equipment and work orders, the same rules as the server's.
  type DemoAsset = Omit<Asset, "sinceService" | "serviceDue" | "openWorkOrders" | "out"> & {
    baseRounds: number;
    lastServiceHours: number | null;
    createdAt: string;
    service: AssetDetail["service"];
  };
  type DemoOrder = Omit<WorkOrderDetail, "overdue" | "asset" | "assignedTo"> & { assetId: string | null; assignedId: string | null };
  const fleet: DemoAsset[] = [];
  const workOrders: DemoOrder[] = [];
  const teedOffAt = new Map<string, string>();
  const cartsInAt = new Map<string, string>();
  let fleetSeeded = false;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  function seedFleet() {
    if (fleetSeeded) return;
    fleetSeeded = true;
    const base = (n: number) => ({ model: null, power: null, serial: null, status: "in_service" as const, statusNote: null, statusChangedAt: hoursAgo(24 * 200), hours: null, notes: null, lastServiceHours: null, createdAt: hoursAgo(24 * 400), service: [], number: String(n) });
    for (let n = 1; n <= 40; n++) {
      // Spread the carts out across their service schedule; a few are due.
      const baseRounds = n === 5 || n === 31 ? 151 : (n * 37) % 140;
      fleet.push({ ...base(n), id: `cart-${n}`, kind: "cart", model: "Club Car Tempo", power: "gas", serviceEvery: 150, lastServiceAt: hoursAgo(24 * (20 + (n % 30))), baseRounds });
    }
    const down = (n: number, note: string, h: number) => Object.assign(fleet.find((a) => a.number === String(n))!, { status: "out_of_service", statusNote: note, statusChangedAt: hoursAgo(h) });
    down(17, "Won't start", 20);
    down(23, "Cracked windshield", 50);
    const machine = (number: string, model: string, power: AssetPower, hours: number, every: number, lastAt: number, serial: string) =>
      fleet.push({ ...base(0), id: `eq-${fleet.length}`, kind: "equipment", number, model, power, hours, serviceEvery: every, lastServiceHours: lastAt, lastServiceAt: hoursAgo(24 * 18), serial, baseRounds: 0 });
    machine("Greens mower 1", "Toro Greensmaster 3150", "diesel", 812, 50, 770, "315-40118");
    machine("Greens mower 2", "Toro Greensmaster 3150", "diesel", 798, 50, 760, "315-40122");
    machine("Fairway mower", "Toro Reelmaster 5510", "diesel", 1432, 100, 1310, "551-20931");
    machine("Utility vehicle", "John Deere Gator TX", "gas", 620, 100, 580, "GTX-77812");
    machine("Range picker", "Club Car Carryall 100", "electric", 288, 200, 160, "CA1-55021");
    machine("Bunker rake", "Toro Sand Pro 3040", "gas", 410, 100, 395, "SP3-11873");
    const mower = fleet.find((a) => a.number === "Greens mower 1")!;
    mower.service.push({ id: id(), kind: "service", note: "Oil, filters, reel backlap", costCents: 18500, hours: 770, workOrderNumber: null, staff: "Riley Chen", at: hoursAgo(24 * 18) });
    const order = (o: Partial<DemoOrder> & { title: string; area: WorkOrderArea; h: number }) => {
      const { h, ...rest } = o;
      const w: DemoOrder = {
        id: id(), number: workOrders.length + 1, details: null, location: null, priority: "normal", status: "open", assetId: null, assignedId: null, reportedBy: "Sam Torres",
        dueDate: null, costCents: 0, completedAt: null, createdAt: hoursAgo(h), updatedAt: hoursAgo(h / 2), notes: [], ...rest,
      };
      workOrders.push(w);
      return w;
    };
    order({ title: "Won't start", area: "carts", assetId: "cart-17", priority: "high", assignedId: "u-4", h: 20, details: "Clicks but doesn't turn over. Battery terminals look corroded." });
    order({ title: "Cracked windshield", area: "carts", assetId: "cart-23", priority: "low", h: 50, notes: [{ id: id(), note: "Windshield ordered, about a week", status: "on_hold", staff: "Riley Chen", at: hoursAgo(30) }], status: "on_hold" });
    order({ title: "Bunker washed out after the storm", area: "course", location: "Hole 7, greenside left", priority: "normal", assignedId: null, h: 6, status: "in_progress", dueDate: todayIn(riverBend.timeZone) });
    order({ title: "Ice machine leaking", area: "clubhouse", location: "Grill kitchen", priority: "urgent", h: 2, reportedBy: "Jordan Price" });
    const done = order({ title: "Reel cutting uneven", area: "equipment", assetId: mower.id, h: 24 * 5, status: "done", costCents: 4200, completedAt: hoursAgo(24 * 4), reportedBy: "Morgan Ellis", assignedId: "u-4" });
    done.notes.push({ id: id(), note: "Adjusted bedknife, new bearing", status: "done", staff: "Riley Chen", at: hoursAgo(24 * 4) });
    mower.service.unshift({ id: id(), kind: "repair", note: "Adjusted bedknife, new bearing", costCents: 4200, hours: 790, workOrderNumber: done.number, staff: "Riley Chen", at: hoursAgo(24 * 4) });
    // Today's groups already out took carts 10 and up when the tee sheet was made.
    for (const b of bookings) if (b.status === "teed_off") teedOffAt.set(b.id, teeTimes.get(b.teeTimeId)!.startsAt);
  }
  const OPEN_ORDERS: WorkOrderStatus[] = ["open", "in_progress", "on_hold"];
  function assetView(a: DemoAsset): Asset {
    const { baseRounds, lastServiceHours, createdAt, service: _, ...rest } = a;
    const since = a.lastServiceAt ?? createdAt;
    const rounds =
      baseRounds +
      bookings.filter((b) => played(b.status) && b.cartNumbers.includes(a.number) && (teedOffAt.get(b.id) ?? teeTimes.get(b.teeTimeId)!.startsAt) >= since && (teedOffAt.get(b.id) ?? teeTimes.get(b.teeTimeId)!.startsAt) <= new Date().toISOString()).length;
    const sinceService = a.kind === "cart" ? rounds : Math.max(0, Math.round(((a.hours ?? 0) - (lastServiceHours ?? 0)) * 10) / 10);
    const outOn =
      a.kind === "cart"
        ? bookings.find((b) => b.status === "teed_off" && b.cartNumbers.includes(a.number) && !cartsInAt.has(b.id) && Date.parse(teedOffAt.get(b.id) ?? "0") > Date.now() - 6 * 3_600_000)
        : undefined;
    return {
      ...rest,
      sinceService,
      serviceDue: a.status !== "retired" && !!a.serviceEvery && sinceService >= a.serviceEvery,
      openWorkOrders: workOrders.filter((w) => w.assetId === a.id && OPEN_ORDERS.includes(w.status)).length,
      out: outOn ? { bookingId: outOn.id, name: outOn.customerName, teedOffAt: teedOffAt.get(outOn.id)! } : null,
    };
  }
  const assetById = (assetId: string) => {
    seedFleet();
    const a = fleet.find((x) => x.id === assetId);
    if (!a) throw new ApiError(404, "not_found", "Cart or equipment not found");
    return a;
  };
  const byNumber = (a: Asset, b: Asset) => a.kind.localeCompare(b.kind) || a.number.localeCompare(b.number, undefined, { numeric: true });
  function orderView(w: DemoOrder): WorkOrderDetail {
    const { assetId, assignedId, ...rest } = w;
    const a = assetId ? fleet.find((x) => x.id === assetId) : undefined;
    const person = assignedId ? accounts.find((x) => x.id === assignedId) : undefined;
    return {
      ...rest,
      notes: [...w.notes],
      asset: a ? { id: a.id, kind: a.kind, number: a.number } : null,
      assignedTo: person ? { id: person.id, name: person.name } : null,
      overdue: !!w.dueDate && w.dueDate < todayIn(riverBend.timeZone) && OPEN_ORDERS.includes(w.status),
    };
  }
  const orderById = (orderId: string) => {
    seedFleet();
    const w = workOrders.find((x) => x.id === orderId);
    if (!w) throw new ApiError(404, "not_found", "Work order not found");
    return w;
  };
  const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
  function assetDetail(a: DemoAsset): AssetDetail {
    return {
      ...assetView(a),
      service: [...a.service],
      workOrders: workOrders.filter((w) => w.assetId === a.id).map(orderView).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, 20),
    };
  }
  function checkCarts(b: DemoBooking, carts: string[]) {
    seedFleet();
    const fresh = carts.filter((c) => !b.cartNumbers.includes(c));
    const fleetCarts = fleet.filter((a) => a.kind === "cart");
    if (!fresh.length || !fleetCarts.length) return;
    const unknown = fresh.filter((n) => !fleetCarts.some((a) => a.number === n));
    if (unknown.length) throw conflict("unknown_cart", `Cart ${unknown.join(", ")} isn't in the fleet. Check the number, or add it under Carts & maintenance`);
    const down = fresh.map((n) => fleetCarts.find((a) => a.number === n)!).filter((a) => a.status !== "in_service");
    if (down.length)
      throw conflict("cart_out_of_service", down.map((c) => `Cart ${c.number} is ${c.status === "retired" ? "retired" : `out of service${c.statusNote ? ` (${c.statusNote})` : ""}`}`).join(". "));
  }

  // Golfer messaging through the simulator, the same rules as the server's.
  type DemoRecipient = { golferId: string | null; name: string; email: string | null; phone: string | null; emailOptOut: boolean; smsOptOut: boolean; teeTime?: string; date?: string };
  const campaigns: (CampaignDetail & { sentById: string | null })[] = [];
  const messageSettings: MessageSettings = { fromName: riverBend.name, replyTo: null, signature: "See you on the course,\nRiver Bend Golf Club pro shop", provider: "simulator" };
  const usableEmail = (e: string | null) => (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !e.endsWith(".invalid") ? e : null);
  const usablePhone = (p: string | null) => {
    const d = (p ?? "").replace(/\D/g, "");
    return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : null;
  };
  const fromGolfer = (g: DemoGolfer | undefined, name: string, phone: string | null): DemoRecipient => ({
    golferId: g?.id ?? null, name: g?.name ?? name, email: g?.email ?? null, phone: g?.phone ?? phone, emailOptOut: !!g?.emailOptOut, smsOptOut: !!g?.smsOptOut,
  });
  function resolveAudience(audience: MessageAudience): { label: string; kind: MessageKind; recipients: DemoRecipient[] } {
    const longDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: riverBend.timeZone });
    if (audience.type === "date" || audience.type === "bookings") {
      seedEvents();
      const picked = bookings
        .filter((b) => {
          const t = teeTimes.get(b.teeTimeId)!;
          if (audience.type === "bookings") return audience.bookingIds.includes(b.id);
          return t.date === audience.date && (b.status === "confirmed" || b.status === "checked_in") && (!audience.from || t.localTime >= audience.from) && (!audience.to || t.localTime <= audience.to);
        })
        .sort((x, y) => teeTimes.get(x.teeTimeId)!.startsAt.localeCompare(teeTimes.get(y.teeTimeId)!.startsAt));
      const seen = new Set<string>();
      const recipients = picked
        .filter((b) => !seen.has(b.golferId ?? b.customerName) && seen.add(b.golferId ?? b.customerName))
        .map((b) => {
          const t = teeTimes.get(b.teeTimeId)!;
          return { ...fromGolfer(golfers.find((g) => g.id === b.golferId), b.customerName, b.customerPhone ?? null), teeTime: formatTime(t.localTime), date: longDay(t.startsAt) };
        });
      if (audience.type === "bookings") return { label: `${picked.length} ${picked.length === 1 ? "group" : "groups"} on the tee sheet`, kind: "operational", recipients };
      const day = longDay(`${audience.date}T12:00:00Z`);
      return { label: audience.from || audience.to ? `Booked ${day}, ${audience.from ?? "first tee time"} to ${audience.to ?? "last"}` : `Everyone booked ${day}`, kind: "operational", recipients };
    }
    if (audience.type === "event") {
      seedEvents();
      const ev = events.find((e) => e.id === audience.eventId);
      if (!ev) throw new ApiError(404, "not_found", "League or outing not found");
      return {
        label: `Players in ${ev.name}`,
        kind: "operational",
        recipients: ev.players.map((p) => {
          const g = golfers.find((x) => x.id === p.golferId);
          return { ...fromGolfer(g, p.name, p.phone), email: p.email ?? g?.email ?? null };
        }),
      };
    }
    if (audience.type === "golfers") return { label: "All golfers with an account", kind: "marketing", recipients: golfers.map((g) => fromGolfer(g, g.name, null)) };
    if (audience.type === "house_accounts")
      return {
        label: "House account holders",
        kind: "marketing",
        recipients: houseAccounts.filter((a) => a.status === "active").map((a) => ({ ...fromGolfer(golfers.find((g) => g.id === a.golferId), "Golfer", null), ...(a.billingEmail ? { email: a.billingEmail } : {}) })),
      };
    const list = golfers.filter((g) => audience.golferIds.includes(g.id));
    if (!list.length) throw new ApiError(404, "not_found", "Golfer account not found");
    return { label: list.length === 1 ? list[0].name : `${list.length} golfers`, kind: "operational", recipients: list.map((g) => fromGolfer(g, g.name, null)) };
  }
  function addressFor(r: DemoRecipient, channel: MessageChannel, kind: MessageKind): { to: string } | { skip: string } {
    const to = channel === "email" ? usableEmail(r.email) : usablePhone(r.phone);
    if (!to) return { skip: channel === "email" ? "No email address" : "No mobile number" };
    if (kind === "marketing" && (channel === "email" ? r.emailOptOut : r.smsOptOut)) return { skip: channel === "email" ? "Opted out of email" : "Opted out of texts" };
    return { to };
  }
  const fill = (template: string, r: DemoRecipient) =>
    template
      .replace(/\{first_name\}/g, r.name.split(/\s+/)[0] ?? r.name)
      .replace(/\{name\}/g, r.name)
      .replace(/\{tee_time\}/g, r.teeTime ?? "your tee time")
      .replace(/\{date\}/g, r.date ?? "")
      .replace(/\{course\}/g, riverBend.name);
  function deliver(kind: MessageKind, label: string, channels: MessageChannel[], subject: string | null, body: string, recipients: DemoRecipient[]): CampaignDetail {
    const at = new Date().toISOString();
    const messages: SentMessage[] = [];
    for (const r of recipients)
      for (const channel of channels) {
        const address = addressFor(r, channel, kind);
        let text = fill(body, r);
        if (channel === "email" && messageSettings.signature) text += `\n\n${messageSettings.signature}`;
        messages.push({
          id: id(), golferId: r.golferId, name: r.name, channel, to: "to" in address ? address.to : null, subject: channel === "email" ? fill(subject ?? riverBend.name, r) : null,
          body: text, status: "to" in address ? "sent" : "skipped", reason: "skip" in address ? address.skip : null, provider: "simulator", at,
        });
      }
    messages.sort((a, b) => a.name.localeCompare(b.name) || a.channel.localeCompare(b.channel));
    const c = {
      id: id(), kind, audienceLabel: label, channels, subject, body, sentBy: account()?.name ?? null, sentById: account()?.id ?? null, sentAt: at,
      golfers: new Set(messages.map((m) => m.golferId ?? m.name)).size, sent: messages.filter((m) => m.status === "sent").length,
      skipped: messages.filter((m) => m.status === "skipped").length, failed: 0, messages,
    };
    campaigns.unshift(c);
    return c;
  }
  const managerAudience = (a: MessageAudience) => (a.type === "golfers" || a.type === "house_accounts") && managerOnly();

  function assignCarts(b: DemoBooking, carts: string[], signatures: WaiverSignature[]) {
    checkCarts(b, carts);
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
  // Gift cards and house accounts.
  const giftCards: (GiftCardDetail & { golferId: string | null })[] = [];
  type DemoAccount = Omit<HouseAccount, "golfer" | "balanceCents" | "unbilledCents" | "availableCents" | "lastStatement"> & { golferId: string; entries: AccountEntry[]; statements: Statement[] };
  const houseAccounts: DemoAccount[] = [];
  const GC_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const gcCode = () => {
    const part = () => Array.from({ length: 4 }, () => GC_CHARS[Math.floor(Math.random() * GC_CHARS.length)]).join("");
    return `GC-${part()}-${part()}`;
  };
  const gcView = ({ golferId: _, history: __, ...g }: (typeof giftCards)[number]): GiftCard => ({ ...g });
  const gcDetail = ({ golferId: _, ...g }: (typeof giftCards)[number]): GiftCardDetail => ({ ...g, history: [...g.history] });
  function gcEntry(g: (typeof giftCards)[number], change: number, kind: GiftCardDetail["history"][number]["kind"], extra: Partial<GiftCardDetail["history"][number]> = {}) {
    g.balanceCents += change;
    g.history.unshift({ changeCents: change, balanceAfter: g.balanceCents, kind, method: null, saleNumber: null, bookingId: null, note: null, staff: account()?.name ?? null, at: new Date().toISOString(), ...extra });
  }
  function findGift(code: string) {
    const g = giftCards.find((x) => x.code === code.trim().toUpperCase().replace(/\s+/g, ""));
    if (!g) throw new ApiError(404, "not_found", "Gift card not found");
    return g;
  }
  function spendGift(code: string, cents: number, extra: { saleNumber?: number; bookingId?: string }, upTo = false) {
    const g = findGift(code);
    if (g.status !== "active") throw conflict("gift_card_void", "That gift card was voided");
    if (g.balanceCents <= 0) throw conflict("gift_card_empty", "That gift card has nothing left on it");
    if (!upTo && g.balanceCents < cents) throw conflict("not_enough_on_card", `The gift card only has ${money(g.balanceCents)} left. Use it toward a round, or pay another way`);
    const amount = Math.min(cents, g.balanceCents);
    gcEntry(g, -amount, "redeem", extra);
    return { card: g, amount };
  }
  const balanceOf = (a: DemoAccount) => a.entries.reduce((s, e) => s + e.amountCents, 0);
  function accountView(a: DemoAccount): HouseAccount {
    const g = golfers.find((x) => x.id === a.golferId)!;
    const { entries, statements, golferId: _, ...rest } = a;
    const balance = balanceOf(a);
    return {
      ...rest,
      billingEmail: a.billingEmail ?? g.email,
      golfer: { id: g.id, name: g.name, email: g.email, phone: g.phone },
      balanceCents: balance,
      unbilledCents: entries.filter((e) => !e.statementId).reduce((s, e) => s + e.amountCents, 0),
      availableCents: a.creditLimitCents === null ? null : Math.max(0, a.creditLimitCents - balance),
      lastStatement: statements[0] ?? null,
    };
  }
  const accountDetail = (a: DemoAccount): HouseAccountDetail => ({ ...accountView(a), entries: [...a.entries], statements: [...a.statements] });
  function findAccount(accountId: string) {
    const a = houseAccounts.find((x) => x.id === accountId);
    if (!a) throw new ApiError(404, "not_found", "House account not found");
    return a;
  }
  function accountEntry(a: DemoAccount, amountCents: number, kind: AccountEntry["kind"], description: string, extra: Partial<AccountEntry> = {}) {
    a.entries.unshift({ id: id(), amountCents, kind, description, method: null, saleNumber: null, bookingId: null, statementId: null, staff: account()?.name ?? null, at: new Date().toISOString(), ...extra });
  }
  function chargeHouse(golferId: string | null | undefined, cents: number, description: string, extra: Partial<AccountEntry> = {}) {
    if (!golferId) throw new ApiError(400, "no_account", "Pick the golfer's account to charge it");
    const a = houseAccounts.find((x) => x.golferId === golferId);
    if (!a) throw conflict("no_house_account", "This golfer doesn't have a house account");
    if (a.status !== "active") throw conflict("account_not_active", a.status === "suspended" ? "This house account is on hold. Ask a manager" : "This house account is closed");
    if (a.creditLimitCents !== null && balanceOf(a) + cents > a.creditLimitCents)
      throw conflict("over_limit", `That would go over the account's limit. ${money(Math.max(0, a.creditLimitCents - balanceOf(a)))} available`);
    if (cents > 0) accountEntry(a, cents, "charge", description, extra);
  }
  /** Gift cards sold and house account payments: money in on a day that isn't revenue. */
  function heldMoney(dayOf: (iso: string) => string, inDay: (d: string) => boolean) {
    const rows: { day: string; what: "gift" | "account"; method: MoneyMethod; cents: number }[] = [];
    for (const g of giftCards) for (const h of g.history) if ((h.kind === "sold" || h.kind === "reload") && h.method && inDay(dayOf(h.at))) rows.push({ day: dayOf(h.at), what: "gift", method: h.method as MoneyMethod, cents: h.changeCents });
    for (const a of houseAccounts) for (const e of a.entries) if (e.kind === "payment" && e.method && inDay(dayOf(e.at))) rows.push({ day: dayOf(e.at), what: "account", method: e.method as MoneyMethod, cents: -e.amountCents });
    return rows;
  }
  function seedAccounts() {
    const by = (name: string) => golfers.find((g) => g.name === name)!;
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    // A birthday gift card on Linda's account, partly spent.
    const linda = by("Linda Hart");
    giftCards.push({
      id: id(), code: "GC-7HRT-2QMX", initialCents: 5000, balanceCents: 0, golfer: { id: linda.id, name: linda.name }, golferId: linda.id, recipientName: "Linda",
      status: "active", issuedBy: "Jordan Price", createdAt: daysAgo(40), history: [],
    });
    const lg = giftCards[0];
    gcEntry(lg, 5000, "sold", { method: "card", staff: "Jordan Price", at: daysAgo(40) });
    gcEntry(lg, -1100, "redeem", { saleNumber: 988, staff: "Jordan Price", at: daysAgo(12) });
    giftCards.push({ id: id(), code: "GC-B4KW-9ZPE", initialCents: 10000, balanceCents: 0, golfer: null, golferId: null, recipientName: "Holiday gift", status: "active", issuedBy: "Morgan Ellis", createdAt: daysAgo(70), history: [] });
    gcEntry(giftCards[1], 10000, "sold", { method: "cash", staff: "Morgan Ellis", at: daysAgo(70) });
    // Chris is a member who charges everything and pays by check each month.
    const chris = by("Chris Patel");
    const acct: DemoAccount = { id: id(), golferId: chris.id, creditLimitCents: 150000, status: "active", billingEmail: null, notes: null, createdAt: daysAgo(400), entries: [], statements: [] };
    houseAccounts.push(acct);
    const first = new Date();
    first.setDate(1);
    const lastStart = new Date(first.getFullYear(), first.getMonth() - 1, 1);
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const lastEnd = new Date(first.getFullYear(), first.getMonth(), 0);
    const st: Statement = { id: id(), periodStart: ymd(lastStart), periodEnd: ymd(lastEnd), openingCents: 0, chargesCents: 31850, paymentsCents: 0, closingCents: 31850, dueOn: ymd(new Date(first.getFullYear(), first.getMonth(), 15)) };
    acct.statements.unshift(st);
    const at = (d: number) => new Date(lastStart.getFullYear(), lastStart.getMonth(), d, 15).toISOString();
    accountEntry(acct, 16800, "charge", "Round, 4 players, 18 holes", { staff: "Jordan Price", at: at(4), statementId: st.id });
    accountEntry(acct, 6550, "charge", "Sale #961: Titleist Pro V1 (dozen), Divot tool with ball marker", { saleNumber: 961, staff: "Jordan Price", at: at(4), statementId: st.id });
    accountEntry(acct, 8500, "charge", "Round, 2 players, 18 holes", { staff: "Casey Morgan", at: at(19), statementId: st.id });
    accountEntry(acct, -31850, "payment", "Payment by check 2207", { method: "check", staff: "Jordan Price", at: daysAgo(2) });
    accountEntry(acct, 4200, "charge", "Sale #1003: Turn burger, Draft beer, Draft beer", { staff: "Casey Morgan", at: daysAgo(1) });
  }

  // Food and bar tabs.
  const tabs: (Omit<Tab, "subtotalCents" | "taxCents" | "waiting">)[] = [];
  function tabView(t: (typeof tabs)[number]): Tab {
    const kept = t.items.filter((i) => i.status !== "void");
    const subtotalCents = kept.reduce((s, i) => s + i.totalCents, 0);
    const taxCents = Math.round((kept.filter((i) => i.taxable).reduce((s, i) => s + i.totalCents, 0) * pos.salesTaxBps) / 10_000);
    return { ...t, items: t.items.map((i) => ({ ...i })), subtotalCents, taxCents, waiting: kept.filter((i) => i.status === "sent" || i.status === "ready").length };
  }
  function findTab(tabId: string, open = true) {
    const t = tabs.find((x) => x.id === tabId);
    if (!t) throw new ApiError(404, "not_found", "Tab not found");
    if (open && t.status !== "open") throw conflict("tab_closed", t.status === "void" ? "This tab was voided" : "This tab has been paid");
    return t;
  }
  function tabItem(l: TabItemInput, at = new Date()): TabItem {
    const base = { id: id(), quantity: l.quantity, note: l.note?.trim() || null, addedBy: account()?.name ?? null, addedAt: at.toISOString() };
    if ("productId" in l) {
      const p = products.find((x) => x.id === l.productId);
      if (!p) throw new ApiError(404, "not_found", "Product not found");
      return { ...base, productId: p.id, description: p.name, category: p.category, unitCents: p.priceCents, totalCents: p.priceCents * l.quantity, taxable: p.taxable, station: p.station, status: p.station ? "sent" : "served" };
    }
    if (!l.description.trim()) throw new ApiError(400, "description_required", "Name the item");
    const station = l.station ?? null;
    return {
      ...base, productId: null, description: l.description.trim(), category: station ? "Food & drink" : "Other", unitCents: l.unitCents, totalCents: l.unitCents * l.quantity,
      taxable: l.taxable ?? true, station, status: station ? "sent" : "served",
    };
  }
  let tabsSeeded = false;
  function seedTabs() {
    if (tabsSeeded) return;
    tabsSeeded = true;
    seedProducts();
    const today = todayIn(riverBend.timeZone);
    ensureDay(today);
    // Mike's foursome made the turn and ordered; the burgers are on the grill and the beers are poured.
    const mike = bookings.find((b) => b.customerName === "Mike Sullivan" && teeTimes.get(b.teeTimeId)?.date === today);
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const open = (name: string, location: TabLocation, extra: Partial<Tab> = {}, min = 20) => {
      const t = { id: id(), name, location, status: "open" as const, golfer: null, bookingId: null, teeTime: null, openedBy: "Casey Morgan", openedAt: ago(min).toISOString(), closedAt: null, saleId: null, voidReason: null, items: [] as TabItem[], ...extra };
      tabs.push(t);
      return t;
    };
    const mt = open("Mike Sullivan", "turn", mike ? { golfer: mike.golferId ? { id: mike.golferId, name: "Mike Sullivan" } : null, bookingId: mike.id, teeTime: teeTimes.get(mike.teeTimeId)!.startsAt } : {}, 9);
    mt.items.push(tabItem({ productId: "pr-BURGER", quantity: 2, note: "One no cheese" }, ago(6)), tabItem({ productId: "pr-WRAP", quantity: 1 }, ago(6)), tabItem({ productId: "pr-DRAFT", quantity: 4 }, ago(6)));
    mt.items.filter((i) => i.station === "bar").forEach((i) => (i.status = "ready"));
    const t2 = open("Table 2", "grill", {}, 35);
    t2.items.push(tabItem({ productId: "pr-BKFST", quantity: 2 }, ago(30)), tabItem({ productId: "pr-COFFEE", quantity: 2 }, ago(30)));
    t2.items.forEach((i) => (i.status = "served"));
    const cart = open("Beverage cart", "cart", {}, 60);
    cart.items.push(tabItem({ productId: "pr-CAN", quantity: 6 }, ago(50)), tabItem({ productId: "pr-H2O", quantity: 4 }, ago(50)));
    const bar = open("Bar: Dave and Kim", "bar", {}, 4);
    bar.items.push(tabItem({ productId: "pr-BMARY", quantity: 2 }, ago(3)), tabItem({ productId: "pr-HOTDOG", quantity: 1, note: "Everything on it" }, ago(3)));
  }

  // Standing tee times, leagues and outings.
  type DemoStanding = Omit<StandingTime, "golferName" | "upcoming"> & { runs: Map<string, { bookingId: string | null; problem: string | null }> };
  type DemoEventDate = { id: string; date: string; startTime: string; slots: number; status: "scheduled" | "cancelled"; held: string[]; pairs: Map<string, { groupNo: number; checkedIn: boolean }> };
  type DemoEvent = Omit<EventSummary, "nextDate" | "dates" | "players"> & {
    dates: DemoEventDate[];
    players: EventDetail["players"];
    payments: (EventDetail["billing"]["payments"][number] & { eventDateId: string | null })[];
  };
  const standing: DemoStanding[] = [];
  const events: DemoEvent[] = [];
  const BOOK_AHEAD_DAYS = 56;
  const weekdayOf = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

  function bookStanding(s: DemoStanding, date: string) {
    if (!s.active || s.runs.has(date) || weekdayOf(date) !== s.weekday || date < s.startsOn || (s.endsOn && date > s.endsOn)) return;
    ensureDay(date);
    const t = [...teeTimes.values()].find((x) => x.date === date && x.localTime === s.localTime);
    const g = golfers.find((x) => x.id === s.golferId)!;
    try {
      if (!t) throw new Error("no tee time at that time");
      if (live(t.id).some((b) => b.golferId === s.golferId)) throw new Error("already booked");
      const b = book({
        teeTimeId: t.id,
        holes: s.holes,
        customer: { name: g.name, email: g.email },
        players: Array.from({ length: s.players }, () => ({ residency: s.residency, ageGroup: "adult" as const })),
        addOns: s.riding ? [{ code: "gas_cart", quantity: s.players }] : [],
      });
      Object.assign(b, { source: "standing", golferId: g.id, customerPhone: g.phone });
      s.runs.set(date, { bookingId: b.id, problem: null });
    } catch (e) {
      s.runs.set(date, { bookingId: null, problem: e instanceof Error ? e.message.toLowerCase() : "couldn't book" });
    }
  }
  function bookAheadAll() {
    const today = todayIn(riverBend.timeZone);
    for (const s of standing) for (let i = 0; i <= BOOK_AHEAD_DAYS; i++) bookStanding(s, addDays(today, i));
  }
  function standingView(s: DemoStanding): StandingTime {
    const today = todayIn(riverBend.timeZone);
    const { runs, ...rest } = s;
    const upcoming = [...runs.entries()]
      .filter(([d]) => d >= today)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, r]) => ({ date, bookingId: r.bookingId && bookings.some((b) => b.id === r.bookingId && b.status !== "cancelled") ? r.bookingId : null, problem: r.problem }));
    return { ...rest, golferName: golfers.find((g) => g.id === s.golferId)?.name ?? "", upcoming };
  }

  /** Blocks a run of tee times for an event date, skipping any that already have golfers on them. */
  function holdTimes(ev: DemoEvent, d: DemoEventDate) {
    ensureDay(d.date);
    const day = [...teeTimes.values()].filter((t) => t.date === d.date && t.localTime >= d.startTime).sort((a, b) => a.localTime.localeCompare(b.localTime));
    const conflicts: HoldConflict[] = [];
    for (const t of day.slice(0, d.slots)) {
      const group = live(t.id);
      if (group.length) {
        conflicts.push({ date: d.date, localTime: t.localTime, detail: group.map((b) => `${b.customerName} (${b.players})`).join(", ") });
        continue;
      }
      Object.assign(t, { status: "blocked", note: ev.name });
      d.held.push(t.id);
    }
    return conflicts;
  }
  function addDate(ev: DemoEvent, date: string, startTime: string, slots: number) {
    const d: DemoEventDate = { id: id(), date, startTime, slots, status: "scheduled", held: [], pairs: new Map() };
    ev.dates.push(d);
    ev.dates.sort((a, b) => a.date.localeCompare(b.date));
    return holdTimes(ev, d);
  }
  function dateCharge(ev: DemoEvent, d: DemoEventDate) {
    if (d.status === "cancelled") return { players: 0, cents: 0 };
    const pairs = [...d.pairs.values()];
    const checked = pairs.filter((p) => p.checkedIn).length;
    const players = checked || pairs.length;
    return { players, cents: players * ev.pricePerPlayerCents };
  }
  function eventDetail(ev: DemoEvent): EventDetail {
    const dates = ev.dates.map((d) => {
      const c = dateCharge(ev, d);
      return { id: d.id, date: d.date, startTime: d.startTime, slots: d.slots, held: d.held.length, status: d.status, paired: d.pairs.size, chargedPlayers: c.players, chargeCents: c.cents };
    });
    const chargedCents = dates.reduce((s, d) => s + d.chargeCents, 0);
    const paidCents = ev.payments.reduce((s, p) => s + p.amountCents, 0);
    const { payments, ...rest } = ev;
    return { ...rest, dates, billing: { chargedCents, paidCents, balanceCents: chargedCents - paidCents, payments: payments.map(({ eventDateId: _, ...p }) => p) } };
  }
  function eventSummary(ev: DemoEvent): EventSummary {
    const today = todayIn(riverBend.timeZone);
    const { dates, players, payments: _, ...rest } = ev;
    return { ...rest, nextDate: dates.find((d) => d.status === "scheduled" && d.date >= today)?.date ?? null, dates: dates.length, players: players.length };
  }
  function findEvent(eventId: string) {
    const ev = events.find((e) => e.id === eventId);
    if (!ev) throw new ApiError(404, "not_found", "Event not found");
    return ev;
  }
  function findDate(dateId: string) {
    for (const ev of events) {
      const d = ev.dates.find((x) => x.id === dateId);
      if (d) return { ev, d };
    }
    throw new ApiError(404, "not_found", "Event date not found");
  }
  function eventDay(ev: DemoEvent, d: DemoEventDate): EventDay {
    const times = d.held.map((tid) => teeTimes.get(tid)!.localTime).sort();
    const holes = riverBend.holes;
    const byGroup = new Map<number, EventDay["groups"][number]["players"]>();
    for (const p of ev.players) {
      const pair = d.pairs.get(p.id);
      if (!pair) continue;
      if (!byGroup.has(pair.groupNo)) byGroup.set(pair.groupNo, []);
      byGroup.get(pair.groupNo)!.push({ id: p.id, name: p.name, golferId: p.golferId, handicap: p.handicap, checkedIn: pair.checkedIn });
    }
    const groups = [...byGroup.entries()]
      .sort(([a], [b]) => a - b)
      .map(([groupNo, players], i) => ({
        groupNo,
        start: ev.format === "shotgun" ? `Hole ${(i % holes) + 1}${i < holes ? "A" : "B"}` : times[i] ?? times[times.length - 1] ?? d.startTime,
        players,
      }));
    return {
      id: d.id,
      eventId: ev.id,
      eventName: ev.name,
      format: ev.format,
      date: d.date,
      startTime: d.startTime,
      status: d.status,
      heldTimes: times,
      groups,
      unpaired: ev.players.filter((p) => !d.pairs.has(p.id)).map((p) => ({ id: p.id, name: p.name, handicap: p.handicap })),
      checkedIn: [...d.pairs.values()].filter((p) => p.checkedIn).length,
    };
  }

  let eventsSeeded = false;
  function seedEvents() {
    if (eventsSeeded) return;
    eventsSeeded = true;
    const today = todayIn(riverBend.timeZone);
    ensureDay(today);
    // Mike's foursome has Saturday 7:02 every week.
    const mike = golfers.find((g) => g.name === "Mike Sullivan")!;
    standing.push({ id: id(), golferId: mike.id, weekday: 6, localTime: "07:02", players: 4, holes: 18, riding: true, residency: "resident", startsOn: today, endsOn: null, active: true, runs: new Map() });
    // A Tuesday night league that started a few weeks ago.
    let tuesday = today;
    while (weekdayOf(tuesday) !== 2) tuesday = addDays(tuesday, -1);
    const league: DemoEvent = {
      id: id(), name: "Tuesday Men's League", kind: "league", format: "tee_times", holes: 9, pricePerPlayerCents: 2500, includesCart: false,
      contactName: "Rich Alvarez", contactEmail: null, contactPhone: "(630) 555-0155", notes: null, active: true, dates: [], players: [], payments: [],
    };
    events.push(league);
    const names: [string, number][] = [["Rich Alvarez", 8], ["Tom Reyes", 14], ["Greg Olson", 21], ["Bob Kim", 11], ["Dave Lindgren", 17], ["Kevin Wu", 6], ["Pete Marsh", 24], ["Joe Bianchi", 12], ["Al Novak", 19], ["Steve Park", 9], ["Mark Doyle", 15], ["Ray Ortiz", 26]];
    for (const [name, handicap] of names) league.players.push({ id: id(), name, golferId: golfers.find((g) => g.name === name)?.id ?? null, email: null, phone: null, handicap });
    for (let w = -3; w <= 8; w++) addDate(league, addDays(tuesday, 7 * w), "16:30", 4);
    // The past nights were played: everyone in groups of four, checked in.
    for (const d of league.dates.filter((x) => x.date < today)) league.players.forEach((p, i) => d.pairs.set(p.id, { groupNo: Math.floor(i / 4) + 1, checkedIn: true }));
    league.payments.push({ id: id(), amountCents: 60000, method: "check", date: null, note: "Check 1042, first two nights", staff: "Jordan Price", eventDateId: null, at: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    // A charity outing next month as a shotgun.
    const outing: DemoEvent = {
      id: id(), name: "Lisle Rotary Charity Scramble", kind: "outing", format: "shotgun", holes: 18, pricePerPlayerCents: 6500, includesCart: true,
      contactName: "Karen Mills", contactEmail: "karen@lislerotary.example", contactPhone: "(630) 555-0168", notes: null, active: true, dates: [], players: [], payments: [],
    };
    events.push(outing);
    addDate(outing, addDays(today, 24), "08:00", 12);
    for (const [name, handicap] of [["Karen Mills", 22], ["Paul Mills", 13], ["Nina Ford", 28], ["Ed Chu", 10], ["Lou Grant", 18], ["Beth Ames", 30], ["Carl Voss", 7], ["Dee Shaw", 25]] as const)
      outing.players.push({ id: id(), name, golferId: null, email: null, phone: null, handicap });
    outing.payments.push({ id: id(), amountCents: 50000, method: "card", date: null, note: "Deposit", staff: "Jordan Price", eventDateId: null, at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    bookAheadAll();
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

  function demoReport(from: string, to: string): Report {
    managerOnly();
    const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(iso));
    const inRange = (d: string) => d >= from && d <= to;
    type Day = Report["days"][number];
    const days = new Map<string, Day>();
    const at = (date: string) => {
      if (!days.has(date)) days.set(date, { date, greenFeesCents: 0, cartsAndExtrasCents: 0, proShopCents: 0, foodBevCents: 0, eventsCents: 0, taxCents: 0, collectedCents: 0, rounds: 0 });
      return days.get(date)!;
    };
    const collected: Record<MoneyMethod, number> = { cash: 0, card: 0, gift_card: 0, punch_card: 0, season_pass: 0, loyalty: 0, rain_check: 0, check: 0, house_account: 0, prepaid: 0, comp: 0 };
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
    const fbCategories = new Map<string, { category: string; cents: number; items: number }>();
    for (const sale of kept.filter((x) => x.status === "completed")) {
      const d = at(dayOf(sale.at));
      d.proShopCents += sale.subtotalCents;
      d.taxCents += sale.taxCents;
      d.collectedCents += sale.totalCents;
      collected[sale.paymentMethod] += sale.totalCents;
      for (const l of sale.lines) {
        const into = l.foodBev ? fbCategories : categories;
        const c = into.get(l.category) ?? { category: l.category, cents: 0, items: 0 };
        c.cents += l.totalCents;
        c.items += l.quantity;
        into.set(l.category, c);
        if (l.foodBev) {
          d.proShopCents -= l.totalCents;
          d.foodBevCents += l.totalCents;
        }
      }
    }
    // League and outing payments count on the day they were taken. Comps are money not collected.
    for (const ev of events)
      for (const p of ev.payments) {
        if (!inRange(dayOf(p.at))) continue;
        const d = at(dayOf(p.at));
        collected[p.method] += p.amountCents;
        if (p.method === "comp") continue;
        d.eventsCents += p.amountCents;
        d.collectedCents += p.amountCents;
      }
    let giftCardsSoldCents = 0;
    let accountPaymentsCents = 0;
    for (const h of heldMoney(dayOf, inRange)) {
      collected[h.method] += h.cents;
      if (h.method === "comp") {
        giftCardsSoldCents += h.cents;
        continue;
      }
      at(h.day).collectedCents += h.cents;
      if (h.what === "gift") giftCardsSoldCents += h.cents;
      else accountPaymentsCents += h.cents;
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
        foodBevCents: sum("foodBevCents"),
        eventsCents: sum("eventsCents"),
        totalCents: sum("greenFeesCents") + sum("cartsAndExtrasCents") + sum("proShopCents") + sum("foodBevCents") + sum("eventsCents"),
        salesTaxCents: sum("taxCents"),
        proShopRefundsCents: kept.filter((x) => x.status === "refunded").reduce((t, x) => t + x.totalCents, 0),
        proShopByCategory: [...categories.values()].sort((a, b) => b.cents - a.cents),
        foodBevByCategory: [...fbCategories.values()].sort((a, b) => b.cents - a.cents),
      },
      collected: { ...collected, totalCents: Object.values(collected).reduce((t, c) => t + c, 0) },
      other: { giftCardsSoldCents, accountPaymentsCents },
      rounds: { played, booked, noShows, openSpots: spots, occupancy: spots ? Math.round((booked / spots) * 1000) / 10 : null, bySource },
      labor: {
        hours: Math.round(worked.reduce((t, p) => t + (Date.parse(p.clockOut!) - Date.parse(p.clockIn)) / 3_600_000, 0) * 10) / 10,
        people: new Set(worked.map((p) => p.staffId)).size,
      },
      days: list,
    };
  }

  const ACCOUNT_DEFAULTS: Record<AccountKey, string> = {
    cash: "Undeposited Funds", card: "Card Clearing", check: "Undeposited Funds", house_account: "Accounts Receivable - House Accounts",
    gift_card: "Gift Cards Outstanding", rain_check: "Rain Checks Outstanding", loyalty: "Loyalty Rewards", punch_card: "Prepaid Rounds",
    season_pass: "Prepaid Rounds", prepaid: "Booking Provider Receivable", comp: "Comps and Promotions", green_fees: "Green Fees",
    carts_extras: "Cart Rentals and Extras", pro_shop: "Pro Shop Sales", food_bev: "Food and Beverage Sales", events: "League and Outing Revenue",
    sales_tax: "Sales Tax Payable", clearing: "Tee Sheet Clearing",
  };
  const MONEY_LINES: [MoneyMethod, string][] = [
    ["cash", "Cash taken"], ["card", "Card payments"], ["check", "Checks taken"], ["house_account", "Charged to house accounts"],
    ["gift_card", "Gift cards spent"], ["rain_check", "Rain checks used"], ["loyalty", "Loyalty points used"], ["punch_card", "Punch card rounds"],
    ["season_pass", "Season pass rounds"], ["prepaid", "Prepaid online through the booking provider"], ["comp", "Comps"],
  ];
  const accounting: { format: AccountingFormat; accounts: Partial<Record<AccountKey, string>>; exports: AccountingSettings["recentExports"] } = { format: "quickbooks", accounts: {}, exports: [] };
  const accountingView = (): AccountingSettings => ({
    format: accounting.format,
    accounts: Object.fromEntries((Object.keys(ACCOUNT_DEFAULTS) as AccountKey[]).map((k) => [k, accounting.accounts[k] || ACCOUNT_DEFAULTS[k]])) as Record<AccountKey, string>,
    defaults: ACCOUNT_DEFAULTS,
    recentExports: accounting.exports.slice(0, 5),
  });
  function demoJournal(from: string, to: string): Journal {
    const { accounts } = accountingView();
    const days: Journal["days"] = [];
    const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: riverBend.timeZone }).format(new Date(iso));
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = demoReport(d, d);
      const eventComps = events.flatMap((ev) => ev.payments).filter((p) => p.method === "comp" && dayOf(p.at) === d).reduce((t, p) => t + p.amountCents, 0);
      const lines: Journal["days"][number]["lines"] = [];
      const line = (key: AccountKey, description: string, cents: number, side: "debit" | "credit") => {
        if (!cents) return;
        const debit = (side === "debit") === cents > 0;
        lines.push({ key, account: accounts[key], description, debitCents: debit ? Math.abs(cents) : 0, creditCents: debit ? 0 : Math.abs(cents) });
      };
      for (const [k, label] of MONEY_LINES) line(k, label, r.collected[k], "debit");
      line("green_fees", "Green fees", r.revenue.greenFeesCents, "credit");
      line("carts_extras", "Carts and extras", r.revenue.cartsAndExtrasCents, "credit");
      line("pro_shop", "Pro shop sales", r.revenue.proShopCents, "credit");
      line("food_bev", "Food and drink sales", r.revenue.foodBevCents, "credit");
      line("events", "Leagues and outings", r.revenue.eventsCents + eventComps, "credit");
      line("sales_tax", "Sales tax collected", r.revenue.salesTaxCents, "credit");
      line("gift_card", "Gift cards sold", r.other.giftCardsSoldCents, "credit");
      line("house_account", "Payments on house accounts", r.other.accountPaymentsCents, "credit");
      const debits = lines.reduce((t, l) => t + l.debitCents, 0);
      const credits = lines.reduce((t, l) => t + l.creditCents, 0);
      line("clearing", "Rounds paid on a different day than played", debits - credits, "credit");
      if (lines.length) days.push({ date: d, lines, totalCents: Math.max(debits, credits) });
    }
    return { from, to, format: accounting.format, days };
  }

  const reply = <T>(fn: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
    try { resolve(fn()); } catch (e) { reject(e); }
  }, 120));

  return {
    course: () => reply(() => ({ ...riverBend, addOns: riverBendAddOns, rates: riverBendRates })),
    teeSheet: (date: string) =>
      reply(() => {
        seedEvents();
        ensureDay(date);
        for (const st of standing) bookStanding(st, date);
        const list = [...teeTimes.values()]
          .filter((t) => t.date === date)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
          .map(({ date: _, ...t }) => {
            const group = live(t.id).map(({ paid: __, ...b }) => ({ ...b, ...fees(b), payment: payment({ ...b, paid: __ }) }));
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
    checkIn: (
      bookingId: string,
      method?: PaymentMethod,
      items?: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod; giftCardCode?: string },
      round?: RoundChoice,
      cardPaymentId?: string,
      redemption?: Redemption,
    ) =>
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
        if (redemption?.pass || redemption?.points) {
          const before = { paid: [...b.paid], card: golferPasses.map((p) => p.roundsUsed), pts: new Map(points) };
          try {
            redeem(b, redemption);
          } catch (e) {
            b.paid = before.paid;
            golferPasses.forEach((p, i) => (p.roundsUsed = before.card[i]));
            points.clear();
            before.pts.forEach((v, k) => points.set(k, v));
            throw e;
          }
        }
        if (redemption?.rainCheck) useRainCheck(b, redemption.rainCheck);
        if (redemption?.giftCard) {
          const used = spendGift(redemption.giftCard, payment(b).balanceCents, { bookingId: b.id }, true);
          if (used.amount > 0) b.paid.push({ amountCents: used.amount, method: "gift_card" });
        }
        const balance = payment(b).balanceCents;
        if (balance > 0 && !method) throw conflict("payment_required", "Take payment before checking in");
        if (balance > 0 && method === "house_account") {
          const t = teeTimes.get(b.teeTimeId)!;
          chargeHouse(b.golferId, balance, `Round, ${b.players} ${b.players === 1 ? "player" : "players"}, ${b.holes} holes, ${formatTime(t.localTime)}`, { bookingId: b.id });
        }
        if (items?.lines.length) earnSale(ringUp({ ...items, golferId: b.golferId }));
        if (balance > 0 && method) b.paid.push({ amountCents: balance, method });
        if (balance > 0 && method && ["card", "cash", "gift_card", "house_account"].includes(method)) earn(b.golferId, balance, "round");
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
    updateGolfer: (golferId: string, patch: { name?: string; email?: string; phone?: string; emailOptOut?: boolean; smsOptOut?: boolean }) =>
      reply(() => {
        const g = golfer(golferId);
        checkGolfer(patch, g.id);
        if (patch.name) g.name = patch.name.trim();
        if (patch.email) g.email = patch.email.trim().toLowerCase();
        if (patch.phone) g.phone = patch.phone.trim();
        if (patch.emailOptOut !== undefined) g.emailOptOut = patch.emailOptOut;
        if (patch.smsOptOut !== undefined) g.smsOptOut = patch.smsOptOut;
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
          foodBev: (input.foodBev ?? false) || !!input.station,
          station: input.station ?? null,
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
        if (p.station) p.foodBev = true;
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
    sell: (input: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod; golferId?: string | null; cardPaymentId?: string; giftCardCode?: string | null }) =>
      reply(() => {
        const card = input.cardPaymentId ? useCard(input.cardPaymentId) : undefined;
        const sale = ringUp(input);
        if (card) card.saleId = sale.id;
        earnSale(sale);
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
        // Money paid from a gift card or charged to an account goes back there.
        for (const g of giftCards) if (g.history.some((h) => h.kind === "redeem" && h.saleNumber === sale.number)) gcEntry(g, sale.totalCents, "adjust", { saleNumber: sale.number, note: `Refund of sale #${sale.number}` });
        if (sale.paymentMethod === "house_account") {
          const a = houseAccounts.find((x) => x.golferId === sale.golfer?.id);
          if (a) accountEntry(a, -sale.totalCents, "adjustment", `Refund of sale #${sale.number}`, { saleNumber: sale.number });
        }
        for (const l of sale.lines) {
          const p = products.find((x) => x.id === l.productId);
          if (p?.trackStock) move(p, l.quantity, "refund", sale.number, null);
        }
        log("Refunded a sale", sale.golfer?.name);
        return sale;
      }),
    report: (from: string, to: string) => reply(() => demoReport(from, to)),
    dayClose: (date: string) => reply(() => demoClose(date)),
    previewMessage: (audience: MessageAudience, channels: MessageChannel[]) =>
      reply((): AudiencePreview => {
        managerAudience(audience);
        const { label, kind, recipients } = resolveAudience(audience);
        const count = (c: MessageChannel) => (channels.includes(c) ? recipients.filter((r) => "to" in addressFor(r, c, kind)).length : 0);
        const reached = recipients.filter((r) => channels.some((c) => "to" in addressFor(r, c, kind))).length;
        return { label, kind, golfers: recipients.length, email: count("email"), sms: count("sms"), unreachable: recipients.length - reached, sample: recipients.slice(0, 8).map((r) => r.name) };
      }),
    sendMessage: (input: { audience: MessageAudience; channels: MessageChannel[]; subject?: string | null; body: string }) =>
      reply(() => {
        managerAudience(input.audience);
        if (!input.channels.length) throw new ApiError(400, "no_channel", "Pick email, text or both");
        if (input.channels.includes("email") && !input.subject?.trim()) throw new ApiError(400, "subject_required", "Add a subject for the email");
        const { label, kind, recipients } = resolveAudience(input.audience);
        if (!recipients.length) throw new ApiError(400, "no_recipients", "Nobody matches. Pick another day or group");
        log("Sent a message to golfers");
        return deliver(kind, label, input.channels, input.subject?.trim() || null, input.body.trim(), recipients);
      }),
    campaigns: () => reply((): Campaign[] => campaigns.map(({ messages: _, sentById: __, ...c }) => c)),
    campaign: (campaignId: string) =>
      reply((): CampaignDetail => {
        const c = campaigns.find((x) => x.id === campaignId);
        if (!c) throw new ApiError(404, "not_found", "Message not found");
        return c;
      }),
    golferMessages: (golferId: string) => reply(() => campaigns.flatMap((c) => c.messages.filter((m) => m.golferId === golferId))),
    messageSettings: () => reply(() => ({ ...messageSettings })),
    saveMessageSettings: (input: { fromName?: string | null; replyTo?: string | null; signature?: string | null }) =>
      reply(() => {
        managerOnly();
        if (input.replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.replyTo)) throw new ApiError(400, "invalid_email", "Enter a real reply-to email address");
        if (input.fromName !== undefined) messageSettings.fromName = input.fromName?.trim() || riverBend.name;
        if (input.replyTo !== undefined) messageSettings.replyTo = input.replyTo?.trim() || null;
        if (input.signature !== undefined) messageSettings.signature = input.signature?.trim() || null;
        log("Changed messaging settings");
        return { ...messageSettings };
      }),
    emailStatement: (statementId: string) =>
      reply(() => {
        managerOnly();
        const a = houseAccounts.find((x) => x.statements.some((st) => st.id === statementId));
        if (!a) throw new ApiError(404, "not_found", "Statement not found");
        const st = a.statements.find((x) => x.id === statementId)!;
        const g = golfers.find((x) => x.id === a.golferId);
        const month = new Date(`${st.periodStart}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        const body = [`Hi {first_name},`, ``, `Here is your ${riverBend.name} house account statement for ${month}.`, ``, `Amount due: ${money(st.closingCents)} by ${st.dueOn}`, ``, `You can pay at the pro shop by check, cash or card.`].join("\n");
        const r = { ...fromGolfer(g, "Golfer", null), email: a.billingEmail ?? g?.email ?? null };
        log("Emailed a statement", r.name);
        return deliver("statement", `Statement for ${r.name}`, ["email"], `${riverBend.name} statement for ${month}`, body, [r]);
      }),
    fleet: (kind?: AssetKind, retired = false) =>
      reply(() => {
        seedFleet();
        return fleet.filter((a) => (!kind || a.kind === kind) && (retired || a.status !== "retired")).map(assetView).sort(byNumber);
      }),
    asset: (assetId: string) => reply(() => assetDetail(assetById(assetId))),
    addAsset: (input: AssetInput & { kind: AssetKind; number: string }) =>
      reply(() => {
        managerOnly();
        seedFleet();
        if (fleet.some((a) => a.kind === input.kind && a.number === input.number)) throw conflict("asset_exists", input.kind === "cart" ? `There's already a cart ${input.number}` : `There's already equipment called ${input.number}`);
        const a: DemoAsset = {
          id: id(), kind: input.kind, number: input.number, model: input.model ?? null, power: input.power ?? null, serial: input.serial ?? null, status: "in_service", statusNote: null,
          statusChangedAt: new Date().toISOString(), serviceEvery: input.serviceEvery ?? null, hours: input.hours ?? null, lastServiceAt: null, notes: input.notes ?? null,
          baseRounds: 0, lastServiceHours: input.hours ?? null, createdAt: new Date().toISOString(), service: [],
        };
        fleet.push(a);
        log("Added a cart or machine");
        return assetView(a);
      }),
    addCarts: (input: { from: number; to: number; model?: string | null; power?: AssetPower | null; serviceEvery?: number | null }) =>
      reply(() => {
        managerOnly();
        seedFleet();
        if (input.to < input.from) throw new ApiError(400, "invalid_range", "The last number has to be at or after the first");
        if (input.to - input.from >= 200) throw new ApiError(400, "too_many", "Add up to 200 carts at a time");
        let added = 0;
        for (let n = input.from; n <= input.to; n++) {
          if (fleet.some((a) => a.kind === "cart" && a.number === String(n))) continue;
          added++;
          fleet.push({
            id: id(), kind: "cart", number: String(n), model: input.model ?? null, power: input.power ?? null, serial: null, status: "in_service", statusNote: null, statusChangedAt: new Date().toISOString(),
            serviceEvery: input.serviceEvery ?? null, hours: null, lastServiceAt: null, notes: null, baseRounds: 0, lastServiceHours: null, createdAt: new Date().toISOString(), service: [],
          });
        }
        log("Added carts to the fleet");
        return { added, carts: fleet.filter((a) => a.kind === "cart" && a.status !== "retired").map(assetView).sort(byNumber) };
      }),
    updateAsset: (assetId: string, input: AssetInput & { retired?: boolean }) =>
      reply(() => {
        managerOnly();
        const a = assetById(assetId);
        if (input.number && input.number !== a.number && fleet.some((x) => x.kind === a.kind && x.number === input.number)) throw conflict("asset_exists", `There's already ${a.kind === "cart" ? "a cart" : "equipment called"} ${input.number}`);
        const { retired, ...fields } = input;
        Object.assign(a, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
        if (retired !== undefined && retired !== (a.status === "retired")) Object.assign(a, { status: retired ? "retired" : "in_service", statusNote: null, statusChangedAt: new Date().toISOString() });
        log("Changed a cart or machine");
        return assetView(a);
      }),
    setAssetStatus: (assetId: string, status: "in_service" | "out_of_service", note?: string | null) =>
      reply(() => {
        const a = assetById(assetId);
        if (a.status === "retired") throw conflict("retired", "This one is retired. A manager can bring it back in the fleet settings");
        if (status === "out_of_service" && !note?.trim()) throw new ApiError(400, "note_required", "Say what's wrong so whoever fixes it knows");
        Object.assign(a, { status, statusNote: status === "out_of_service" ? note!.trim() : null, statusChangedAt: new Date().toISOString() });
        log("Changed whether a cart or machine is in service");
        return assetView(a);
      }),
    logService: (assetId: string, input: { kind: "service" | "repair" | "inspection"; note?: string | null; costCents?: number; hours?: number | null }) =>
      reply(() => {
        const a = assetById(assetId);
        if (input.hours != null && a.hours != null && input.hours < a.hours) throw new ApiError(400, "hours_back", `The meter was at ${a.hours} hours. It can't go back`);
        if (input.hours != null) a.hours = input.hours;
        a.service.unshift({ id: id(), kind: input.kind, note: input.note?.trim() || null, costCents: input.costCents ?? 0, hours: a.hours, workOrderNumber: null, staff: account()?.name ?? null, at: new Date().toISOString() });
        if (input.kind === "service") Object.assign(a, { lastServiceAt: new Date().toISOString(), lastServiceHours: a.hours, baseRounds: 0 });
        log("Logged a service or repair");
        return assetDetail(a);
      }),
    setHours: (assetId: string, hours: number) =>
      reply(() => {
        const a = assetById(assetId);
        if (a.kind !== "equipment") throw new ApiError(400, "not_equipment", "Carts are counted in rounds, not hours");
        if (a.hours != null && hours < a.hours) throw new ApiError(400, "hours_back", `The meter was at ${a.hours} hours. It can't go back`);
        a.hours = hours;
        return assetView(a);
      }),
    cartsIn: (bookingId: string) =>
      reply(() => {
        seedFleet();
        const b = find(bookingId);
        if (b.status !== "teed_off" || !b.cartNumbers.length) throw conflict("no_carts_out", "This group has no carts out");
        cartsInAt.set(b.id, new Date().toISOString());
        b.cartsIn = true;
        log("Marked carts back in", b.customerName);
        return fleet.filter((a) => a.kind === "cart" && a.status !== "retired").map(assetView).sort(byNumber);
      }),
    workOrders: (filter: { status?: "open" | "closed" | "all"; assetId?: string; assignedTo?: string; area?: WorkOrderArea } = {}) =>
      reply((): WorkOrder[] => {
        seedFleet();
        const statuses: WorkOrderStatus[] | null = filter.status === "closed" ? ["done", "cancelled"] : filter.status === "all" ? null : OPEN_ORDERS;
        const list = workOrders
          .filter((w) => (!statuses || statuses.includes(w.status)) && (!filter.assetId || w.assetId === filter.assetId) && (!filter.assignedTo || w.assignedId === filter.assignedTo) && (!filter.area || w.area === filter.area))
          .map(orderView)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (filter.status !== "closed" && filter.status !== "all")
          list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Number(b.overdue) - Number(a.overdue) || a.createdAt.localeCompare(b.createdAt));
        return list.map(({ notes: _, ...w }) => w);
      }),
    workOrder: (orderId: string) => reply(() => orderView(orderById(orderId))),
    createWorkOrder: (input: WorkOrderInput) =>
      reply(() => {
        seedFleet();
        const a = input.assetId ? assetById(input.assetId) : undefined;
        if (input.outOfService && !a) throw new ApiError(400, "no_asset", "Pick the cart or machine to take out of service");
        const now = new Date().toISOString();
        const w: DemoOrder = {
          id: id(), number: workOrders.length + 1, title: input.title, details: input.details?.trim() || null, area: a ? (a.kind === "cart" ? "carts" : "equipment") : input.area,
          location: input.location?.trim() || null, priority: input.priority ?? "normal", status: "open", assetId: a?.id ?? null, assignedId: input.assignedTo ?? null,
          reportedBy: account()?.name ?? null, dueDate: input.dueDate ?? null, costCents: 0, completedAt: null, createdAt: now, updatedAt: now, notes: [],
        };
        workOrders.push(w);
        if (input.outOfService && a!.status === "in_service") Object.assign(a!, { status: "out_of_service", statusNote: input.title, statusChangedAt: now });
        log("Reported a problem");
        return orderView(w);
      }),
    updateWorkOrder: (orderId: string, input: Partial<Omit<WorkOrderInput, "area" | "assetId" | "outOfService">> & { costCents?: number }) =>
      reply(() => {
        const w = orderById(orderId);
        const { assignedTo, ...rest } = input;
        Object.assign(w, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), { updatedAt: new Date().toISOString() });
        if (assignedTo !== undefined) w.assignedId = assignedTo;
        log("Changed a work order");
        return orderView(w);
      }),
    setWorkOrderStatus: (orderId: string, input: { status: WorkOrderStatus; note?: string | null; backInService?: boolean; costCents?: number }) =>
      reply(() => {
        const w = orderById(orderId);
        if (input.status === "cancelled" && role() !== "manager") throw conflict("manager_only", "Only a manager can cancel a work order");
        if (input.status === w.status) throw conflict("same_status", "The work order is already at that step");
        const now = new Date().toISOString();
        const done = input.status === "done";
        Object.assign(w, { status: input.status, updatedAt: now, completedAt: done ? now : null, costCents: input.costCents ?? w.costCents });
        w.notes.push({ id: id(), note: input.note?.trim() || null, status: input.status, staff: account()?.name ?? null, at: now });
        const a = w.assetId ? fleet.find((x) => x.id === w.assetId) : undefined;
        if (done && a) {
          a.service.unshift({ id: id(), kind: "repair", note: input.note?.trim() || w.title, costCents: w.costCents, hours: a.hours, workOrderNumber: w.number, staff: account()?.name ?? null, at: now });
          if (input.backInService && a.status === "out_of_service") Object.assign(a, { status: "in_service", statusNote: null, statusChangedAt: now });
        }
        log("Moved a work order along");
        return orderView(w);
      }),
    addWorkOrderNote: (orderId: string, note: string) =>
      reply(() => {
        const w = orderById(orderId);
        w.notes.push({ id: id(), note: note.trim(), status: null, staff: account()?.name ?? null, at: new Date().toISOString() });
        w.updatedAt = new Date().toISOString();
        return orderView(w);
      }),
    accountingSettings: () => reply(() => (managerOnly(), accountingView())),
    saveAccountingSettings: (input: { format?: AccountingFormat; accounts?: Partial<Record<AccountKey, string>> }) =>
      reply(() => {
        managerOnly();
        if (input.format) accounting.format = input.format;
        for (const [k, v] of Object.entries(input.accounts ?? {}) as [AccountKey, string][]) {
          if (v.trim() && v.trim() !== ACCOUNT_DEFAULTS[k]) accounting.accounts[k] = v.trim();
          else delete accounting.accounts[k];
        }
        log("Changed accounting settings");
        return accountingView();
      }),
    journal: (from: string, to: string) => reply(() => (managerOnly(), demoJournal(from, to))),
    exportJournal: (from: string, to: string, format?: AccountingFormat) =>
      reply(() => {
        managerOnly();
        const j = demoJournal(from, to);
        const fmt = format ?? j.format;
        const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const amt = (c: number) => (c / 100).toFixed(2);
        const [y, mo, da] = [0, 1, 2] as const;
        const parts = (d: string) => d.split("-");
        const rows: string[][] = [];
        if (fmt === "quickbooks") {
          rows.push(["Journal No", "Journal Date", "Account", "Debits", "Credits", "Description"]);
          for (const d of j.days) {
            const p = parts(d.date);
            for (const l of d.lines) rows.push([`GOLF-${p.join("")}`, `${p[mo]}/${p[da]}/${p[y]}`, l.account, l.debitCents ? amt(l.debitCents) : "", l.creditCents ? amt(l.creditCents) : "", l.description]);
          }
        } else {
          rows.push(["*Narration", "*Date", "Description", "*AccountCode", "*TaxRate", "*Amount"]);
          for (const d of j.days) {
            const p = parts(d.date);
            for (const l of d.lines) rows.push([`${riverBend.name} daily summary ${d.date}`, `${p[da]}/${p[mo]}/${p[y]}`, l.description, l.account, "Tax Exempt", amt(l.debitCents - l.creditCents)]);
          }
        }
        accounting.exports.unshift({ from, to, format: fmt, staff: account()?.name ?? null, at: new Date().toISOString() });
        log(`Exported the daily summary for ${fmt === "xero" ? "Xero" : "QuickBooks"}`);
        return { fileName: `${riverBend.slug}-${fmt}-${from}${from === to ? "" : `-to-${to}`}.csv`, csv: rows.map((r) => r.map(cell).join(",")).join("\n") + "\n", days: j.days.length };
      }),
    closeDay: (date: string, input: { countedCashCents: number; note?: string | null }) =>
      reply(() => {
        const expected = demoClose(date).expected;
        if (closes.has(date) && role() !== "manager") throw conflict("already_closed", "This day is already closed. Ask a manager to close it again");
        const overShortCents = input.countedCashCents - expected.cash;
        if (overShortCents !== 0 && !input.note?.trim()) throw new ApiError(400, "note_required", "The drawer is over or short. Add a note saying why");
        closes.set(date, {
          expectedCashCents: expected.cash,
          countedCashCents: input.countedCashCents,
          overShortCents,
          note: input.note?.trim() || null,
          closedBy: account()?.name ?? null,
          closedAt: new Date().toISOString(),
        });
        log("Closed the day");
        return demoClose(date);
      }),
    passTypes: () => reply(() => passTypes.map((t) => ({ ...t }))),
    addPassType: (t: { name: string; kind: PassType["kind"]; priceCents: number; rounds?: number | null; validDays?: number | null; coversCart?: boolean }) =>
      reply(() => {
        managerOnly();
        if (!t.name.trim()) throw new ApiError(400, "invalid_name", "Give the pass a name");
        if (t.kind === "punch_card" && !t.rounds) throw new ApiError(400, "rounds_required", "Say how many rounds the punch card is for");
        const type: PassType = { id: id(), name: t.name.trim(), kind: t.kind, priceCents: t.priceCents, rounds: t.kind === "punch_card" ? t.rounds! : null, validDays: t.validDays ?? null, coversCart: !!t.coversCart, active: true };
        passTypes.push(type);
        log("Added a pass type");
        return { ...type };
      }),
    updatePassType: (typeId: string, patch: Partial<Omit<PassType, "id" | "kind">>) =>
      reply(() => {
        managerOnly();
        const t = passTypes.find((x) => x.id === typeId);
        if (!t) throw new ApiError(404, "not_found", "Pass type not found");
        Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
        log("Changed a pass type");
        return { ...t };
      }),
    loyaltySettings: () => reply(() => ({ ...loyalty })),
    saveLoyaltySettings: (next: LoyaltySettings) =>
      reply(() => {
        managerOnly();
        Object.assign(loyalty, next);
        log("Changed loyalty points");
        return { ...loyalty };
      }),
    wallet: (golferId: string) => reply(() => wallet(golferId)),
    sellPass: (golferId: string, input: { passTypeId: string; paymentMethod: SalePaymentMethod; cardPaymentId?: string }) =>
      reply(() => {
        wallet(golferId);
        const t = passTypes.find((x) => x.id === input.passTypeId);
        if (!t) throw new ApiError(404, "not_found", "Pass type not found");
        if (!t.active) throw new ApiError(400, "pass_type_inactive", `${t.name} is no longer sold`);
        const card = input.cardPaymentId ? useCard(input.cardPaymentId) : undefined;
        const sale = ringUp({ lines: [{ description: t.name, unitCents: t.priceCents, quantity: 1, taxable: false }], paymentMethod: input.paymentMethod, golferId });
        if (card) card.saleId = sale.id;
        earnSale(sale);
        golferPasses.unshift({
          id: id(), golferId, name: t.name, kind: t.kind, roundsTotal: t.rounds, roundsUsed: 0, coversCart: t.coversCart,
          expiresAt: t.validDays ? new Date(Date.now() + t.validDays * 86_400_000).toISOString() : null, soldAt: new Date().toISOString(), status: "active",
        });
        log(`Sold a ${t.name}`, golfers.find((g) => g.id === golferId)?.name);
        return wallet(golferId);
      }),
    cancelPass: (golferId: string, passId: string) =>
      reply(() => {
        managerOnly();
        const p = golferPasses.find((x) => x.id === passId && x.golferId === golferId);
        if (!p) throw new ApiError(404, "not_found", "Pass not found");
        p.status = "cancelled";
        log("Cancelled a pass");
        return wallet(golferId);
      }),
    adjustPoints: (golferId: string, change: number, note: string) =>
      reply(() => {
        managerOnly();
        wallet(golferId);
        if (!note.trim()) throw new ApiError(400, "note_required", "Say why the points are changing");
        changePoints(golferId, change, "adjust", note.trim());
        log("Adjusted loyalty points");
        return wallet(golferId);
      }),
    issueRainCheck: (bookingId: string, input: { players: number; holesPlayed: number; includeCart?: boolean; amountCents?: number; note?: string | null }) =>
      reply(() => {
        const b = find(bookingId);
        const m = roundMoney(b);
        if (input.amountCents !== undefined) managerOnly();
        if (input.players > b.players) throw new ApiError(400, "too_many_players", `This group only has ${b.players} players`);
        if (input.holesPlayed >= b.holes) throw new ApiError(400, "round_finished", "They played every hole, so there's nothing to credit");
        const share = (input.players / b.players) * ((b.holes - input.holesPlayed) / b.holes);
        const amount = input.amountCents ?? Math.round(m.green * share) + (input.includeCart ?? true ? Math.round(m.carts * share) : 0);
        if (amount <= 0) throw new ApiError(400, "nothing_to_credit", "That comes to nothing");
        if (amount > m.givable) throw conflict("too_much", `Only ${money(m.givable)} is left on this round to give back`);
        b.originalCents ??= b.totalCents;
        b.totalCents -= amount;
        b.payment = payment(b);
        const rc: RainCheck = {
          id: id(), code: rcCode(), bookingId: b.id, golferId: b.golferId, name: b.customerName, players: input.players, holesUnplayed: b.holes - input.holesPlayed,
          amountCents: amount, remainingCents: amount, expiresAt: new Date(Date.now() + rainCheckSettings.rainCheckDays * 86_400_000).toISOString(),
          status: "active", note: input.note?.trim() || null, issuedBy: account()?.name ?? null, issuedAt: new Date().toISOString(), usable: true,
        };
        rainChecks.unshift(rc);
        log("Issued a rain check", b.customerName);
        return rcView(rc);
      }),
    bookingRainChecks: (bookingId: string) => reply(() => rainChecks.filter((r) => r.bookingId === bookingId).map(rcView)),
    findRainCheck: (code: string) =>
      reply(() => {
        const r = rainChecks.find((x) => x.code === code.trim().toUpperCase());
        if (!r) throw new ApiError(404, "not_found", "Rain check not found");
        return rcView(r);
      }),
    voidRainCheck: (rcId: string) =>
      reply(() => {
        managerOnly();
        const r = rainChecks.find((x) => x.id === rcId);
        if (!r) throw new ApiError(404, "not_found", "Rain check not found");
        if (r.status === "void") throw conflict("already_void", "This rain check is already void");
        if (r.remainingCents !== r.amountCents) throw conflict("already_used", "Part of this rain check has been used, so it can't be voided");
        r.status = "void";
        const b = bookings.find((x) => x.id === r.bookingId);
        if (b) {
          b.totalCents += r.amountCents;
          b.payment = payment(b);
        }
        log("Voided a rain check");
        return rcView(r);
      }),
    refundRound: (bookingId: string, input: { amountCents: number; method: "cash" | "card"; reason: string }) =>
      reply(() => {
        managerOnly();
        if (!input.reason.trim()) throw new ApiError(400, "reason_required", "Say why the round is being refunded");
        const b = find(bookingId);
        const m = roundMoney(b);
        const inMethod = b.paid.filter((p) => p.method === input.method).reduce((t, p) => t + p.amountCents, 0);
        const most = Math.min(m.givable, inMethod);
        if (input.amountCents > most) throw conflict("too_much", `Only ${money(most)} paid by ${input.method} can be refunded on this round`);
        b.originalCents ??= b.totalCents;
        b.paid.push({ amountCents: -input.amountCents, method: input.method });
        b.totalCents -= input.amountCents;
        b.payment = payment(b);
        log("Refunded a round", b.customerName);
        return b;
      }),
    rainCheckSettings: () => reply(() => ({ ...rainCheckSettings })),
    saveRainCheckSettings: (next: { rainCheckDays: number }) =>
      reply(() => {
        managerOnly();
        rainCheckSettings.rainCheckDays = next.rainCheckDays;
        log("Changed rain check settings");
        return { ...rainCheckSettings };
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
        teedOffAt.set(b.id, new Date().toISOString());
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
    tabs: (status: "open" | "closed" = "open") =>
      reply(() => {
        seedTabs();
        return tabs.filter((t) => t.status === status).sort((a, b) => b.openedAt.localeCompare(a.openedAt)).map(tabView);
      }),
    tab: (tabId: string) => reply(() => tabView(findTab(tabId, false))),
    openTab: (input: { name?: string | null; location?: TabLocation; golferId?: string | null; bookingId?: string | null }) =>
      reply(() => {
        seedTabs();
        const b = input.bookingId ? find(input.bookingId) : undefined;
        if (b && tabs.some((t) => t.bookingId === b.id && t.status === "open")) throw conflict("tab_open", "This group already has an open tab");
        const g = input.golferId ? golfer(input.golferId) : b?.golferId ? golfers.find((x) => x.id === b.golferId) : undefined;
        const name = input.name?.trim() || b?.customerName || g?.name;
        if (!name) throw new ApiError(400, "name_required", "Name the tab, e.g. the golfer or the table");
        const t = {
          id: id(), name, location: input.location ?? "grill", status: "open" as const, golfer: g ? { id: g.id, name: g.name } : null, bookingId: b?.id ?? null,
          teeTime: b ? teeTimes.get(b.teeTimeId)!.startsAt : null, openedBy: account()?.name ?? null, openedAt: new Date().toISOString(), closedAt: null, saleId: null, voidReason: null, items: [],
        };
        tabs.push(t);
        log("Opened a tab", g?.name);
        return tabView(t);
      }),
    renameTab: (tabId: string, name: string) =>
      reply(() => {
        if (!name.trim()) throw new ApiError(400, "name_required", "Name the tab");
        const t = findTab(tabId);
        t.name = name.trim();
        return tabView(t);
      }),
    addTabItems: (tabId: string, lines: TabItemInput[]) =>
      reply(() => {
        const t = findTab(tabId);
        if (!lines.length) throw new ApiError(400, "empty_order", "Add something first");
        t.items.push(...lines.map((l) => tabItem(l)));
        return tabView(t);
      }),
    voidTabItem: (tabId: string, itemId: string) =>
      reply(() => {
        const t = findTab(tabId);
        const i = t.items.find((x) => x.id === itemId);
        if (!i) throw new ApiError(404, "not_found", "Item not found");
        if (i.station && i.status !== "sent" && i.status !== "void" && account()?.role !== "manager") throw conflict("already_made", "It's already been made. Ask a manager to take it off");
        i.status = "void";
        log("Took an item off a tab");
        return tabView(t);
      }),
    closeTab: (tabId: string, paymentMethod: SalePaymentMethod, cardPaymentId?: string, giftCardCode?: string) =>
      reply(() => {
        const t = findTab(tabId);
        const kept = t.items.filter((i) => i.status !== "void");
        if (!kept.length) throw new ApiError(400, "empty_tab", "There's nothing on this tab. Void it instead");
        const card = cardPaymentId ? useCard(cardPaymentId) : undefined;
        const sale = ringUp({
          lines: kept.map((i) =>
            i.productId ? { productId: i.productId, quantity: i.quantity, unitCents: i.unitCents } : { description: i.description, unitCents: i.unitCents, quantity: i.quantity, taxable: i.taxable, category: i.category, foodBev: !!i.station },
          ),
          paymentMethod,
          golferId: t.golfer?.id ?? null,
          giftCardCode,
        });
        earnSale(sale);
        if (card) card.saleId = sale.id;
        kept.forEach((i) => (i.status = "served"));
        Object.assign(t, { status: "closed", saleId: sale.id, closedAt: new Date().toISOString() });
        log("Closed a tab", t.golfer?.name);
        return { tab: tabView(t), sale };
      }),
    voidTab: (tabId: string, reason: string) =>
      reply(() => {
        const t = findTab(tabId);
        if (t.items.some((i) => i.status !== "void") && account()?.role !== "manager") throw conflict("tab_has_items", "Only a manager can void a tab with items on it");
        if (!reason.trim()) throw new ApiError(400, "reason_required", "Say why it's being voided");
        t.items.forEach((i) => (i.status = "void"));
        Object.assign(t, { status: "void", voidReason: reason.trim(), closedAt: new Date().toISOString() });
        log("Voided a tab");
        return tabView(t);
      }),
    prep: (station: PrepStation) =>
      reply(() => {
        seedTabs();
        const tickets = new Map<string, PrepTicket>();
        const rows = tabs
          .filter((t) => t.status === "open")
          .flatMap((t) => t.items.filter((i) => i.station === station && (i.status === "sent" || i.status === "ready")).map((i) => ({ t, i })))
          .sort((a, b) => a.i.addedAt.localeCompare(b.i.addedAt));
        for (const { t, i } of rows) {
          const key = `${t.id}:${Math.floor(Date.parse(i.addedAt) / 60_000)}`;
          if (!tickets.has(key)) tickets.set(key, { key, tabId: t.id, tabName: t.name, location: t.location, orderedAt: i.addedAt, by: i.addedBy, items: [] });
          tickets.get(key)!.items.push({ ...i });
        }
        return [...tickets.values()];
      }),
    setPrepStatus: (itemIds: string[], status: "sent" | "ready" | "served") =>
      reply(() => {
        let updated = 0;
        for (const t of tabs.filter((x) => x.status === "open"))
          for (const i of t.items)
            if (itemIds.includes(i.id) && i.station && i.status !== "void") {
              i.status = status;
              updated++;
            }
        if (!updated) throw new ApiError(404, "not_found", "Item not found");
        return { updated };
      }),
    giftCards: (q = "") =>
      reply(() => {
        ensureDay(todayIn(riverBend.timeZone));
        const m = q.trim().toLowerCase();
        return giftCards
          .filter((g) => !m || g.code.toLowerCase().includes(m) || g.recipientName?.toLowerCase().includes(m) || g.golfer?.name?.toLowerCase().includes(m))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(gcView);
      }),
    findGiftCard: (code: string) => reply(() => gcDetail(findGift(code))),
    giftCard: (cardId: string) =>
      reply(() => {
        const g = giftCards.find((x) => x.id === cardId);
        if (!g) throw new ApiError(404, "not_found", "Gift card not found");
        return gcDetail(g);
      }),
    sellGiftCard: (input: { amountCents: number; method: GiftCardMethod; cardPaymentId?: string; golferId?: string | null; recipientName?: string | null; code?: string | null; note?: string | null }) =>
      reply(() => {
        if (input.method === "comp") managerOnly();
        if (input.amountCents < 100) throw new ApiError(400, "invalid_amount", "A gift card is at least $1");
        const card = input.cardPaymentId ? useCard(input.cardPaymentId) : undefined;
        let g: (typeof giftCards)[number];
        if (input.code) {
          g = findGift(input.code);
          if (g.status !== "active") throw conflict("gift_card_void", "That gift card was voided");
          gcEntry(g, input.amountCents, "reload", { method: input.method, note: input.note ?? null });
        } else {
          const owner = input.golferId ? golfer(input.golferId) : undefined;
          g = {
            id: id(), code: gcCode(), initialCents: input.amountCents, balanceCents: 0, golfer: owner ? { id: owner.id, name: owner.name } : null, golferId: owner?.id ?? null,
            recipientName: input.recipientName?.trim() || null, status: "active", issuedBy: account()?.name ?? null, createdAt: new Date().toISOString(), history: [],
          };
          giftCards.push(g);
          gcEntry(g, input.amountCents, "sold", { method: input.method, note: input.note ?? null });
        }
        if (card) card.saleId = g.id;
        log("Sold a gift card", g.golfer?.name ?? undefined);
        return gcDetail(g);
      }),
    adjustGiftCard: (cardId: string, input: { changeCents?: number; void?: boolean; note: string }) =>
      reply(() => {
        managerOnly();
        const g = giftCards.find((x) => x.id === cardId)!;
        if (!input.note.trim()) throw new ApiError(400, "note_required", "Say why");
        if (g.status !== "active") throw conflict("gift_card_void", "That gift card was voided");
        if (input.void) {
          gcEntry(g, -g.balanceCents, "void", { note: input.note.trim() });
          g.status = "void";
        } else if (input.changeCents) {
          if (g.balanceCents + input.changeCents < 0) throw new ApiError(400, "negative_balance", "That would take the card below zero");
          gcEntry(g, input.changeCents, "adjust", { note: input.note.trim() });
        }
        log("Changed a gift card");
        return gcDetail(g);
      }),
    houseAccounts: () =>
      reply(() => {
        ensureDay(todayIn(riverBend.timeZone));
        return houseAccounts.map(accountView).sort((a, b) => a.status.localeCompare(b.status) || a.golfer.name.localeCompare(b.golfer.name));
      }),
    houseAccount: (accountId: string) => reply(() => accountDetail(findAccount(accountId))),
    openHouseAccount: (input: { golferId: string; creditLimitCents?: number | null; billingEmail?: string | null; notes?: string | null }) =>
      reply(() => {
        managerOnly();
        golfer(input.golferId);
        if (houseAccounts.some((a) => a.golferId === input.golferId)) throw conflict("account_exists", "This golfer already has a house account");
        const a: DemoAccount = {
          id: id(), golferId: input.golferId, creditLimitCents: input.creditLimitCents ?? null, status: "active", billingEmail: input.billingEmail?.trim() || null,
          notes: input.notes?.trim() || null, createdAt: new Date().toISOString(), entries: [], statements: [],
        };
        houseAccounts.push(a);
        log("Opened a house account", golfers.find((g) => g.id === a.golferId)?.name);
        return accountDetail(a);
      }),
    updateHouseAccount: (accountId: string, patch: { creditLimitCents?: number | null; status?: HouseAccount["status"]; billingEmail?: string | null; notes?: string | null }) =>
      reply(() => {
        managerOnly();
        const a = findAccount(accountId);
        if (patch.status === "closed" && balanceOf(a) !== 0) throw conflict("balance_owing", "Settle the balance before closing the account");
        Object.assign(a, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
        log("Changed a house account");
        return accountDetail(a);
      }),
    payHouseAccount: (accountId: string, input: { amountCents: number; method: "card" | "cash" | "check"; cardPaymentId?: string; note?: string | null }) =>
      reply(() => {
        const a = findAccount(accountId);
        if (input.amountCents <= 0) throw new ApiError(400, "invalid_amount", "Enter an amount");
        const card = input.cardPaymentId ? useCard(input.cardPaymentId) : undefined;
        if (card) card.saleId = a.id;
        const note = input.note?.trim();
        accountEntry(a, -input.amountCents, "payment", input.method === "check" ? `Payment by check${note ? ` ${note}` : ""}` : `Payment by ${input.method}${note ? `: ${note}` : ""}`, { method: input.method });
        log("Took a house account payment", golfers.find((g) => g.id === a.golferId)?.name);
        return accountDetail(a);
      }),
    adjustHouseAccount: (accountId: string, input: { amountCents: number; description: string }) =>
      reply(() => {
        managerOnly();
        const a = findAccount(accountId);
        if (!input.description.trim()) throw new ApiError(400, "description_required", "Say what it's for");
        accountEntry(a, input.amountCents, "adjustment", input.description.trim());
        return accountDetail(a);
      }),
    runStatements: (month: string) =>
      reply(() => {
        managerOnly();
        const [y, m] = month.split("-").map(Number);
        const start = new Date(y, m - 1, 1);
        const end = new Date(y, m, 1);
        if (end.getTime() > Date.now() + 86_400_000) throw new ApiError(400, "month_not_over", "Statements are made once the month is over");
        const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        let made = 0;
        for (const a of houseAccounts.filter((x) => x.status !== "closed")) {
          if (a.statements.some((st) => st.periodStart === ymd(start))) continue;
          const opening = a.entries.filter((e) => e.statementId).reduce((t, e) => t + e.amountCents, 0);
          const entries = a.entries.filter((e) => !e.statementId && Date.parse(e.at) < end.getTime());
          if (!entries.length && opening === 0) continue;
          const charges = entries.filter((e) => e.amountCents > 0).reduce((t, e) => t + e.amountCents, 0);
          const payments = -entries.filter((e) => e.amountCents < 0).reduce((t, e) => t + e.amountCents, 0);
          const st: Statement = {
            id: id(), periodStart: ymd(start), periodEnd: ymd(new Date(y, m, 0)), openingCents: opening, chargesCents: charges, paymentsCents: payments,
            closingCents: opening + charges - payments, dueOn: ymd(new Date(y, m, 15)),
          };
          entries.forEach((e) => (e.statementId = st.id));
          a.statements.unshift(st);
          made++;
        }
        log("Made house account statements");
        return { month, statements: made };
      }),
    statement: (statementId: string) =>
      reply((): StatementDetail => {
        const a = houseAccounts.find((x) => x.statements.some((st) => st.id === statementId));
        if (!a) throw new ApiError(404, "not_found", "Statement not found");
        const st = a.statements.find((x) => x.id === statementId)!;
        return { ...st, account: accountView(a), entries: a.entries.filter((e) => e.statementId === statementId).sort((x, y) => x.at.localeCompare(y.at)) };
      }),
    standingTimes: () =>
      reply(() => {
        seedEvents();
        return standing.map(standingView);
      }),
    addStandingTime: (input: Omit<StandingTime, "id" | "golferName" | "active" | "upcoming">) =>
      reply(() => {
        managerOnly();
        seedEvents();
        golfer(input.golferId);
        if (!/^\d{2}:\d{2}$/.test(input.localTime) || !at(todayIn(riverBend.timeZone), input.localTime))
          throw new ApiError(400, "not_a_tee_time", "Pick a time on the tee sheet, e.g. 07:02");
        const s: DemoStanding = { ...input, id: id(), active: true, runs: new Map() };
        standing.push(s);
        bookAheadAll();
        log("Added a standing tee time", golfers.find((g) => g.id === s.golferId)?.name);
        return standingView(s);
      }),
    setStandingTimeActive: (standingId: string, active: boolean) =>
      reply(() => {
        managerOnly();
        const s = standing.find((x) => x.id === standingId);
        if (!s) throw new ApiError(404, "not_found", "Standing tee time not found");
        s.active = active;
        const today = todayIn(riverBend.timeZone);
        if (!active)
          for (const [date, r] of s.runs) {
            const b = r.bookingId ? bookings.find((x) => x.id === r.bookingId) : undefined;
            if (date >= today && b?.status === "confirmed") b.status = "cancelled";
            if (date >= today) s.runs.delete(date);
          }
        else bookAheadAll();
        log(active ? "Started a standing tee time" : "Stopped a standing tee time", golfers.find((g) => g.id === s.golferId)?.name);
        return standingView(s);
      }),
    bookAhead: () =>
      reply(() => {
        seedEvents();
        bookAheadAll();
        return standing.map(standingView);
      }),
    events: () =>
      reply(() => {
        seedEvents();
        return events.map(eventSummary);
      }),
    event: (eventId: string) =>
      reply(() => {
        seedEvents();
        return eventDetail(findEvent(eventId));
      }),
    addEvent: (input: NewEvent) =>
      reply(() => {
        managerOnly();
        seedEvents();
        if (!input.name.trim()) throw new ApiError(400, "name_required", "Give it a name");
        const { schedule, ...rest } = input;
        const ev: DemoEvent = {
          includesCart: false, contactName: null, contactEmail: null, contactPhone: null, notes: null,
          ...rest, name: input.name.trim(), id: id(), active: true, dates: [], players: [], payments: [],
        };
        const last = input.kind === "league" && schedule.endsOn ? schedule.endsOn : schedule.startsOn;
        const conflicts: HoldConflict[] = [];
        for (let d = schedule.startsOn, n = 0; d <= last && n < 40; d = addDays(d, 7), n++) conflicts.push(...addDate(ev, d, schedule.startTime, schedule.slots));
        events.push(ev);
        log(`Set up ${ev.name}`);
        return { event: eventDetail(ev), conflicts };
      }),
    updateEvent: (eventId: string, patch: Partial<Omit<NewEvent, "kind" | "format" | "schedule">> & { active?: boolean }) =>
      reply(() => {
        managerOnly();
        return eventDetail(Object.assign(findEvent(eventId), patch));
      }),
    addEventDate: (eventId: string, input: { date: string; startTime: string; slots: number }) =>
      reply(() => {
        managerOnly();
        const ev = findEvent(eventId);
        if (ev.dates.some((d) => d.date === input.date && d.status === "scheduled")) throw conflict("date_exists", "That date is already on the schedule");
        const conflicts = addDate(ev, input.date, input.startTime, input.slots);
        return { event: eventDetail(ev), conflicts };
      }),
    cancelEventDate: (dateId: string) =>
      reply(() => {
        managerOnly();
        const { ev, d } = findDate(dateId);
        d.status = "cancelled";
        for (const tid of d.held) Object.assign(teeTimes.get(tid)!, { status: "open", note: null });
        d.held = [];
        log(`Cancelled ${ev.name} on ${d.date}`);
        return eventDetail(ev);
      }),
    addEventPlayer: (eventId: string, p: { name?: string; golferId?: string | null; email?: string | null; phone?: string | null; handicap?: number | null }) =>
      reply(() => {
        const ev = findEvent(eventId);
        const g = p.golferId ? golfer(p.golferId) : undefined;
        const name = g?.name ?? p.name?.trim();
        if (!name) throw new ApiError(400, "name_required", "Enter the player's name");
        if (g && ev.players.some((x) => x.golferId === g.id)) throw conflict("already_playing", `${g.name} is already in ${ev.name}`);
        ev.players.push({ id: id(), name, golferId: g?.id ?? null, email: g?.email ?? p.email ?? null, phone: g?.phone ?? p.phone ?? null, handicap: p.handicap ?? null });
        return eventDetail(ev);
      }),
    removeEventPlayer: (eventId: string, playerId: string) =>
      reply(() => {
        const ev = findEvent(eventId);
        ev.players = ev.players.filter((p) => p.id !== playerId);
        for (const d of ev.dates) if (d.date >= todayIn(riverBend.timeZone)) d.pairs.delete(playerId);
        return eventDetail(ev);
      }),
    eventDay: (dateId: string) =>
      reply(() => {
        const { ev, d } = findDate(dateId);
        return eventDay(ev, d);
      }),
    autoPair: (dateId: string, opts: { groupSize: number; order: "name" | "random" | "handicap" }) =>
      reply(() => {
        const { ev, d } = findDate(dateId);
        const list = [...ev.players];
        if (opts.order === "name") list.sort((a, b) => a.name.localeCompare(b.name));
        else if (opts.order === "random") list.sort(() => Math.random() - 0.5);
        else list.sort((a, b) => (a.handicap ?? 99) - (b.handicap ?? 99));
        const groups = Math.max(1, Math.ceil(list.length / opts.groupSize));
        const was = new Map(d.pairs);
        d.pairs.clear();
        list.forEach((p, i) => {
          // Handicap order deals players out like cards, back and forth, so each group gets a spread.
          const round = Math.floor(i / groups);
          const k = i % groups;
          const groupNo = opts.order === "handicap" ? (round % 2 === 0 ? k : groups - 1 - k) + 1 : Math.floor(i / opts.groupSize) + 1;
          d.pairs.set(p.id, { groupNo, checkedIn: was.get(p.id)?.checkedIn ?? false });
        });
        return eventDay(ev, d);
      }),
    setPairing: (dateId: string, playerId: string, groupNo: number | null) =>
      reply(() => {
        const { ev, d } = findDate(dateId);
        if (groupNo === null) d.pairs.delete(playerId);
        else d.pairs.set(playerId, { groupNo, checkedIn: d.pairs.get(playerId)?.checkedIn ?? false });
        return eventDay(ev, d);
      }),
    eventCheckIn: (dateId: string, playerIds: string[], checkedIn: boolean) =>
      reply(() => {
        const { ev, d } = findDate(dateId);
        for (const pid of playerIds) {
          const p = d.pairs.get(pid);
          if (p) p.checkedIn = checkedIn;
        }
        log(checkedIn ? `Checked in ${ev.name}` : `Undid check-in for ${ev.name}`);
        return eventDay(ev, d);
      }),
    addEventPayment: (eventId: string, p: { amountCents: number; method: EventPaymentMethod; eventDateId?: string | null; note?: string | null; cardPaymentId?: string }) =>
      reply(() => {
        const ev = findEvent(eventId);
        if (!Number.isInteger(p.amountCents) || p.amountCents === 0) throw new ApiError(400, "invalid_amount", "Enter an amount");
        if (p.amountCents < 0) managerOnly();
        if (p.cardPaymentId) useCard(p.cardPaymentId);
        const d = p.eventDateId ? ev.dates.find((x) => x.id === p.eventDateId) : undefined;
        ev.payments.unshift({ id: id(), amountCents: p.amountCents, method: p.method, date: d?.date ?? null, note: p.note ?? null, staff: account()?.name ?? null, eventDateId: d?.id ?? null, at: new Date().toISOString() });
        log(`${p.amountCents < 0 ? "Refunded" : "Took a payment for"} ${ev.name}`, ev.contactName ?? undefined);
        return eventDetail(ev);
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
