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
  payment: PaymentSummary;
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
  stats: { roundsPlayed: number; holesPlayed: number; noShows: number; cancelled: number; upcoming: number; paidCents: number };
  history: { bookingId: string; startsAt: string; course: string; players: number; holes: number; status: BookingStatus; source: string; totalCents: number; paidCents: number }[];
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
    checkIn: (id: string, method?: PaymentMethod) =>
      request(`/bookings/${id}/check-in`, { method: "POST", body: method ? { payment: { method } } : {} }),
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
    cancel: (id: string) => request(`/bookings/${id}/cancel`, { method: "POST" }),
    move: (id: string, teeTimeId: string) => request(`/bookings/${id}/move`, { method: "POST", body: { teeTimeId } }),
  };
}

export type Client = ReturnType<typeof createHttpClient>;
