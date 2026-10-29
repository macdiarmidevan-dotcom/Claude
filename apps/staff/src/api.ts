// Typed client for the golf API. Staff use a secret (sk_) key for their course.

export interface Settings {
  apiUrl: string;
  courseSlug: string;
  apiKey: string;
}

export interface Course {
  slug: string;
  name: string;
  timeZone: string;
  holes: number;
  addOns: { code: string; name: string; priceCents: number }[];
}

export type BookingStatus = "confirmed" | "checked_in" | "cancelled" | "no_show";

export interface SheetBooking {
  id: string;
  teeTimeId: string;
  customerName: string;
  customerPhone: string | null;
  players: number;
  holes: number;
  status: BookingStatus;
  source: string;
  totalCents: number;
  cartNumbers: string[];
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createClient(settings: Settings) {
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
    checkIn: (id: string, cartNumbers: string[]) =>
      request(`/bookings/${id}/check-in`, { method: "POST", body: { cartNumbers } }),
    setCarts: (id: string, cartNumbers: string[]) =>
      request(`/bookings/${id}/carts`, { method: "PUT", body: { cartNumbers } }),
    noShow: (id: string) => request(`/bookings/${id}/no-show`, { method: "POST" }),
    cancel: (id: string) => request(`/bookings/${id}/cancel`, { method: "POST" }),
    move: (id: string, teeTimeId: string) => request(`/bookings/${id}/move`, { method: "POST", body: { teeTimeId } }),
  };
}

export type Client = ReturnType<typeof createClient>;
