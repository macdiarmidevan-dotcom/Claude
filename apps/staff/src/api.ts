// Typed client for the golf API. Staff sign in with their own email and password, which gives a
// session token (st_…). A shared device key (sk_) still works for kiosks.
import type { RateRule } from "@golf/core";
import { createDemoClient, demoSignIn, DEMO, DEMO_URL } from "./demo";

export type Station = "proshop" | "starter";

export interface Settings {
  apiUrl: string;
  courseSlug: string;
  /** The signed-in person's session token, or a shared device key. */
  apiKey: string;
  /** Which job this device does: the pro shop takes payment and checks in, the starter sends groups off. */
  station: Station;
  /** The card reader next to this device, when the course has connected a processor. */
  terminalId?: string;
}

export interface Course {
  slug: string;
  name: string;
  timeZone: string;
  holes: number;
  addOns: { code: string; name: string; priceCents: number }[];
  rates: RateRule[];
}

export type BookingStatus = "confirmed" | "checked_in" | "teed_off" | "cancelled" | "no_show";
export type PaymentMethod = "card" | "cash" | "prepaid" | "punch_card" | "gift_card" | "comp";

export interface PaymentSummary {
  status: "paid" | "partial" | "unpaid";
  paidCents: number;
  balanceCents: number;
  methods: PaymentMethod[];
}

export interface SheetBooking {
  id: string;
  teeTimeId: string;
  customerName: string;
  customerPhone: string | null;
  /** The golfer account this booking counts toward. Empty until the pro shop links or creates one. */
  golferId: string | null;
  players: number;
  holes: number;
  status: BookingStatus;
  source: string;
  totalCents: number;
  cartNumbers: string[];
  /** Carts whose driver has signed the waiver for this booking. */
  signedCarts: string[];
  /** Riding in carts, or walking. */
  riding: boolean;
  /** Paying resident rates. */
  resident: boolean;
  payment: PaymentSummary;
}

export type ProcessorId = "standalone" | "simulator" | "stripe" | "square";

export interface PaymentSettings {
  provider: ProcessorId;
  /** False on a standalone terminal: the register only records card payments. */
  connected: boolean;
  account: Record<string, string>;
  hasCredentials: boolean;
  tipping: boolean;
  currency: string;
  providers: { id: ProcessorId; name: string; connected: boolean; fields: { key: string; label: string; secret: boolean; required: boolean; help?: string }[] }[];
}

export interface CardTerminal {
  id: string;
  name: string;
  readerId: string;
  location: string | null;
  provider: ProcessorId;
  active: boolean;
}

export interface CardPayment {
  id: string;
  terminalId: string;
  terminal: string;
  amountCents: number;
  tipCents: number;
  status: "processing" | "succeeded" | "failed" | "cancelled";
  failureMessage: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  refundedCents: number;
  bookingId: string | null;
  saleId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RoundChoice {
  residency: "resident" | "nonresident";
  riding: boolean;
}

export interface Waiver {
  id: string;
  version: number;
  title: string;
  body: string;
}

export interface WaiverSignature {
  cartNumber: string;
  driverName: string;
  signature: string;
}

export interface SheetTeeTime {
  id: string;
  startsAt: string;
  localTime: string;
  maxPlayers: number;
  bookedPlayers: number;
  status: "open" | "blocked";
  note: string | null;
  bookings: SheetBooking[];
}

export interface WalkIn {
  teeTimeId: string;
  holes: number;
  customer: { name: string; email: string; phone?: string };
  players: { residency: "resident" | "nonresident"; ageGroup: "adult" | "senior" | "junior" }[];
  addOns: { code: string; quantity: number }[];
}

export type ImportSource = "teeitup" | "golfnow" | "import";

export interface ImportResult {
  dryRun: boolean;
  dates: string[];
  counts: { created: number; updated: number; cancelled: number; unchanged: number; problems: number };
  changes: { action: "create" | "update" | "cancel" | "no_show" | "unchanged" | "skip"; externalId: string; date: string; time: string; name: string; players: number; detail?: string }[];
  problems: { line: number; message: string }[];
  overbooked: { date: string; time: string; players: number; maxPlayers: number }[];
}

export type SyncMethod = "report_url" | "provider_api";

export interface SyncConnection {
  source: ImportSource;
  method: SyncMethod;
  reportUrl: string | null;
  hasCredentials: boolean;
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "waiting" | null;
  lastMessage: string | null;
}

export interface SyncSettings {
  source: ImportSource;
  method: SyncMethod;
  reportUrl?: string | null;
  /** Left out keeps the saved sign-in details; null removes them. */
  credentials?: Record<string, string> | null;
  enabled: boolean;
  intervalMinutes: number;
}

export interface ImportRun {
  id: string;
  source: ImportSource;
  fileName: string | null;
  dates: string[];
  counts: { created: number; updated: number; cancelled: number; unchanged: number; problems: number };
  /** Whether someone uploaded a file or the automatic sync brought it in. */
  via?: "upload" | "sync";
  createdAt: string;
}

export type Role = "staff" | "manager";

export interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The job they do, such as Pro Shop or Cart Attendant. */
  employeeType: { id: string; name: string } | null;
  active: boolean;
  lastLoginAt: string | null;
}

export interface EmployeeType {
  id: string;
  name: string;
  /** Removed types aren't offered for new picks but stay on the people who had them. */
  active: boolean;
  staffCount: number;
}

export interface Me {
  role: Role;
  /** Empty when the device uses a shared key rather than a person's sign-in. */
  user: StaffUser | null;
}

export interface ActivityEntry {
  actor: string;
  action: string;
  golfer: string | null;
  bookingId: string | null;
  detail: Record<string, unknown>;
  at: string;
}

export interface GolferAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  roundsPlayed: number;
  lastPlayed: string | null;
  createdAt: string;
}

export interface GolferProfile extends GolferAccount {
  createdBy: string | null;
  /** paidCents is what the golfer paid for their own rounds; their guests' fees aren't in it. */
  stats: { roundsPlayed: number; holesPlayed: number; noShows: number; cancelled: number; upcoming: number; guestsBrought: number; paidCents: number };
  /** Everyone else in the group is the golfer's guest. paidCents is the golfer's own share. */
  history: { bookingId: string; startsAt: string; course: string; players: number; guests: number; holes: number; status: BookingStatus; source: string; paidCents: number }[];
}

export interface Shift {
  id: string;
  staff: { id: string; name: string } | null;
  employeeType: { id: string; name: string } | null;
  date: string;
  start: string;
  end: string;
  startsAt: string;
  endsAt: string;
  hours: number;
  note: string | null;
}

export interface ShiftInput {
  staffUserId?: string | null;
  employeeTypeId?: string | null;
  date: string;
  start: string;
  end: string;
  note?: string | null;
}

export interface Punch {
  id: string;
  staff: { id: string; name: string };
  shiftId: string | null;
  clockIn: string;
  clockOut: string | null;
  hours: number | null;
  edited: boolean;
}

export interface Timesheet {
  staff: { id: string; name: string };
  scheduledHours: number;
  workedHours: number;
  open: boolean;
  punches: Punch[];
}

export type SwapStatus = "awaiting_coworker" | "awaiting_manager" | "approved" | "declined" | "rejected" | "cancelled";
export type SwapAction = "accept" | "decline" | "approve" | "reject" | "cancel";

export interface Swap {
  id: string;
  status: SwapStatus;
  from: { id: string; name: string };
  to: { id: string; name: string };
  offered: Shift;
  requested: Shift | null;
  message: string | null;
  createdAt: string;
}

export type SalePaymentMethod = "card" | "cash" | "gift_card" | "comp";

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  category: string;
  priceCents: number;
  costCents: number | null;
  taxable: boolean;
  trackStock: boolean;
  stock: number;
  reorderLevel: number;
  /** Stock is at or below the reorder level. */
  low: boolean;
  active: boolean;
}

export interface ProductInput {
  name: string;
  sku?: string | null;
  category?: string;
  priceCents: number;
  costCents?: number | null;
  taxable?: boolean;
  trackStock?: boolean;
  reorderLevel?: number;
  stock?: number;
}

export interface StockMovement {
  id: string;
  change: number;
  stockAfter: number;
  reason: "sale" | "refund" | "receive" | "count" | "adjust";
  saleNumber: number | null;
  note: string | null;
  staff: string | null;
  at: string;
}

export type SaleLineInput = { productId: string; quantity: number } | { description: string; unitCents: number; quantity: number; taxable?: boolean };

export interface Sale {
  id: string;
  number: number;
  at: string;
  staff: string | null;
  golfer: { id: string; name: string } | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paymentMethod: SalePaymentMethod;
  status: "completed" | "refunded";
  lines: { productId: string | null; description: string; category: string; quantity: number; unitCents: number; totalCents: number; taxable: boolean }[];
}

export interface SalesDay {
  sales: Sale[];
  summary: {
    count: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    refundedCents: number;
    byMethod: Partial<Record<SalePaymentMethod, number>>;
    byCategory: Record<string, number>;
  };
}

export type MoneyMethod = "cash" | "card" | "gift_card" | "punch_card" | "prepaid" | "comp";

export interface Report {
  from: string;
  to: string;
  revenue: {
    greenFeesCents: number;
    cartsAndExtrasCents: number;
    proShopCents: number;
    /** Green fees, carts and extras, and pro shop sales before tax. */
    totalCents: number;
    salesTaxCents: number;
    proShopRefundsCents: number;
    proShopByCategory: { category: string; cents: number; items: number }[];
  };
  collected: Record<MoneyMethod, number> & { totalCents: number };
  rounds: { played: number; booked: number; noShows: number; openSpots: number; occupancy: number | null; bySource: Record<string, number> };
  labor: { hours: number; people: number };
  days: { date: string; greenFeesCents: number; cartsAndExtrasCents: number; proShopCents: number; taxCents: number; collectedCents: number; rounds: number }[];
}

export interface DayClose {
  date: string;
  expected: Record<MoneyMethod, number>;
  close: { expectedCashCents: number; countedCashCents: number; overShortCents: number; note: string | null; closedBy: string | null; closedAt: string } | null;
}

export interface Coworker {
  id: string;
  name: string;
  employeeType: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Signs someone in with their email and password. The token goes in Settings.apiKey. */
export async function signIn(apiUrl: string, courseSlug: string, email: string, password: string): Promise<{ token: string; user: StaffUser }> {
  if (DEMO && apiUrl === DEMO_URL) return demoSignIn(email, password);
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/courses/${encodeURIComponent(courseSlug)}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `Sign in failed (${res.status})`);
  return data;
}

export function createClient(settings: Pick<Settings, "apiUrl" | "courseSlug" | "apiKey">): Client {
  if (DEMO && settings.apiUrl === DEMO_URL) return createDemoClient(settings.apiKey);
  return createHttpClient(settings);
}

function createHttpClient(settings: Pick<Settings, "apiUrl" | "courseSlug" | "apiKey">) {
  const base = `${settings.apiUrl.replace(/\/$/, "")}/v1/courses/${encodeURIComponent(settings.courseSlug)}`;

  async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(base + path, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `Request failed (${res.status})`);
    }
    return data as T;
  }

  return {
    course: () => request<Course>(""),
    teeSheet: (date: string) => request<{ date: string; teeTimes: SheetTeeTime[] }>(`/tee-sheet?date=${date}`),
    setTeeTime: (id: string, patch: { status?: "open" | "blocked"; note?: string | null }) =>
      request(`/tee-times/${id}`, { method: "PATCH", body: patch }),
    book: (walkIn: WalkIn) => request(`/bookings`, { method: "POST", body: { ...walkIn, source: "staff" } }),
    /** Checks a group in, taking what's owed for the round and ringing up any items bought with it. */
    /** round: the pro shop's rate and walking/riding for the group, re-priced before payment. */
    /** cardPaymentId: a card that went through on a connected reader, covering everything paid by card. */
    checkIn: (id: string, method?: PaymentMethod, items?: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod }, round?: RoundChoice, cardPaymentId?: string) =>
      request(`/bookings/${id}/check-in`, {
        method: "POST",
        body: { ...(method ? { payment: { method } } : {}), ...(items ? { items } : {}), ...(round ? { round } : {}), ...(cardPaymentId ? { cardPaymentId } : {}) },
      }),
    waiver: () => request<Waiver>("/waiver"),
    /** Who is signed in. Managers can change course settings; other staff can't. */
    me: () => request<Me>("/me"),
    logout: () => request("/logout", { method: "POST" }),
    changePassword: (current: string, next: string) => request("/me/password", { method: "PUT", body: { current, next } }),
    staff: () => request<StaffUser[]>("/staff"),
    addStaff: (input: { name: string; email: string; role: Role; password: string; employeeTypeId?: string | null }) =>
      request<StaffUser>("/staff", { method: "POST", body: input }),
    updateStaff: (id: string, patch: { name?: string; role?: Role; active?: boolean; password?: string; employeeTypeId?: string | null }) =>
      request<StaffUser>(`/staff/${id}`, { method: "PATCH", body: patch }),
    employeeTypes: () => request<EmployeeType[]>("/employee-types"),
    addEmployeeType: (name: string) => request<EmployeeType>("/employee-types", { method: "POST", body: { name } }),
    updateEmployeeType: (id: string, patch: { name?: string; active?: boolean }) =>
      request<EmployeeType>(`/employee-types/${id}`, { method: "PATCH", body: patch }),
    activity: () => request<ActivityEntry[]>("/activity"),
    shifts: (from: string, to: string) => request<Shift[]>(`/shifts?from=${from}&to=${to}`),
    addShift: (input: ShiftInput) => request<Shift>("/shifts", { method: "POST", body: input }),
    updateShift: (id: string, patch: Partial<ShiftInput>) => request<Shift>(`/shifts/${id}`, { method: "PATCH", body: patch }),
    deleteShift: (id: string) => request(`/shifts/${id}`, { method: "DELETE" }),
    copyWeek: (from: string, to: string) => request<{ copied: number; skipped: number }>("/shifts/copy-week", { method: "POST", body: { from, to } }),
    clock: () => request<{ open: Punch | null; nextShift: Shift | null }>("/clock"),
    clockIn: () => request<{ open: Punch | null; nextShift: Shift | null }>("/clock/in", { method: "POST" }),
    clockOut: () => request<{ open: Punch | null; nextShift: Shift | null }>("/clock/out", { method: "POST" }),
    timesheets: (from: string, to: string) => request<Timesheet[]>(`/timesheets?from=${from}&to=${to}`),
    swaps: () => request<Swap[]>("/swaps"),
    askSwap: (input: { offeredShiftId: string; toUserId: string; requestedShiftId?: string | null; message?: string | null }) =>
      request<Swap>("/swaps", { method: "POST", body: input }),
    answerSwap: (id: string, action: SwapAction) => request<Swap>(`/swaps/${id}/${action}`, { method: "POST" }),
    coworkers: () => request<Coworker[]>("/coworkers"),
    schedulingSettings: () => request<{ swapsNeedApproval: boolean }>("/settings/scheduling"),
    saveSchedulingSettings: (settings: { swapsNeedApproval: boolean }) =>
      request<{ swapsNeedApproval: boolean }>("/settings/scheduling", { method: "PUT", body: settings }),
    products: (opts: { q?: string; all?: boolean } = {}) =>
      request<Product[]>(`/products?q=${encodeURIComponent(opts.q ?? "")}${opts.all ? "&all=1" : ""}`),
    addProduct: (input: ProductInput) => request<Product>("/products", { method: "POST", body: input }),
    updateProduct: (id: string, patch: Partial<Omit<ProductInput, "stock">> & { active?: boolean }) =>
      request<Product>(`/products/${id}`, { method: "PATCH", body: patch }),
    productHistory: (id: string) => request<StockMovement[]>(`/products/${id}/history`),
    changeStock: (id: string, change: { kind: "receive" | "count" | "adjust"; quantity: number; note?: string | null }) =>
      request<Product>(`/products/${id}/stock`, { method: "POST", body: change }),
    sell: (sale: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod; golferId?: string | null; cardPaymentId?: string }) =>
      request<Sale>("/sales", { method: "POST", body: sale }),
    paymentSettings: () => request<PaymentSettings>("/settings/payments"),
    savePaymentSettings: (input: { provider: ProcessorId; account?: Record<string, string>; credentials?: Record<string, string>; tipping?: boolean }) =>
      request<PaymentSettings>("/settings/payments", { method: "PUT", body: input }),
    discoverReaders: () => request<{ readerId: string; label: string; online: boolean | null }[]>("/settings/payments/readers"),
    terminals: () => request<CardTerminal[]>("/terminals"),
    addTerminal: (input: { name: string; readerId: string; location?: string | null }) => request<CardTerminal>("/terminals", { method: "POST", body: input }),
    updateTerminal: (id: string, patch: { name?: string; location?: string | null; active?: boolean }) =>
      request<CardTerminal>(`/terminals/${id}`, { method: "PATCH", body: patch }),
    /** Sends an amount to a card reader; then check cardPayment until it's no longer processing. */
    startCardPayment: (input: { terminalId: string; amountCents: number; description?: string }) =>
      request<CardPayment>("/card-payments", { method: "POST", body: input }),
    cardPayment: (id: string) => request<CardPayment>(`/card-payments/${id}`),
    cancelCardPayment: (id: string) => request<CardPayment>(`/card-payments/${id}/cancel`, { method: "POST" }),
    sales: (date: string) => request<SalesDay>(`/sales?date=${date}`),
    refundSale: (id: string) => request<Sale>(`/sales/${id}/refund`, { method: "POST" }),
    posSettings: () => request<{ salesTaxBps: number }>("/settings/pos"),
    savePosSettings: (settings: { salesTaxBps: number }) => request<{ salesTaxBps: number }>("/settings/pos", { method: "PUT", body: settings }),
    report: (from: string, to: string) => request<Report>(`/reports?from=${from}&to=${to}`),
    dayClose: (date: string) => request<DayClose>(`/closes/${date}`),
    closeDay: (date: string, close: { countedCashCents: number; note?: string | null }) =>
      request<DayClose>(`/closes/${date}`, { method: "PUT", body: close }),
    searchGolfers: (q: string) => request<GolferAccount[]>(`/golfers?q=${encodeURIComponent(q)}`),
    golfer: (id: string) => request<GolferProfile>(`/golfers/${id}`),
    /** Creates a golfer's account, usually at their first check-in, and links that booking. */
    createGolfer: (input: { name: string; email: string; phone: string; bookingId?: string }) =>
      request<GolferProfile>("/golfers", { method: "POST", body: input }),
    updateGolfer: (id: string, patch: { name?: string; email?: string; phone?: string }) =>
      request<GolferProfile>(`/golfers/${id}`, { method: "PATCH", body: patch }),
    linkGolfer: (bookingId: string, golferId: string) =>
      request<GolferProfile>(`/bookings/${bookingId}/golfer`, { method: "PUT", body: { golferId } }),
    saveWaiver: (waiver: { title: string; body: string }) => request<Waiver>("/waiver", { method: "PUT", body: waiver }),
    importTeeSheet: (body: { source: ImportSource; csv: string; fileName?: string; dryRun?: boolean }) =>
      request<ImportResult>("/imports", { method: "POST", body }),
    imports: () => request<ImportRun[]>("/imports"),
    sync: () => request<SyncConnection | null>("/sync"),
    saveSync: (settings: SyncSettings) => request<SyncConnection>("/sync", { method: "PUT", body: settings }),
    removeSync: () => request("/sync", { method: "DELETE" }),
    syncNow: () => request<{ connection: SyncConnection; result?: ImportResult }>("/sync/run", { method: "POST" }),
    teeOff: (id: string, cartNumbers: string[], waivers: WaiverSignature[]) =>
      request(`/bookings/${id}/tee-off`, { method: "POST", body: { cartNumbers, waivers } }),
    setCarts: (id: string, cartNumbers: string[], waivers: WaiverSignature[]) =>
      request(`/bookings/${id}/carts`, { method: "PUT", body: { cartNumbers, waivers } }),
    noShow: (id: string) => request(`/bookings/${id}/no-show`, { method: "POST" }),
    undoNoShow: (id: string) => request(`/bookings/${id}/undo-no-show`, { method: "POST" }),
    cancel: (id: string) => request(`/bookings/${id}/cancel`, { method: "POST" }),
    move: (id: string, teeTimeId: string) => request(`/bookings/${id}/move`, { method: "POST", body: { teeTimeId } }),
    removePlayers: (id: string, count: number) => request(`/bookings/${id}/remove-players`, { method: "POST", body: { count } }),
    addGuests: (id: string, guests: { count: number; riding: boolean; residency?: "resident" | "nonresident" }) =>
      request(`/bookings/${id}/guests`, { method: "POST", body: guests }),
  };
}

export type Client = ReturnType<typeof createHttpClient>;
