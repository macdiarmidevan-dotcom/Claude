import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError, badRequest } from "./errors.ts";

// Card processors the register can send amounts to. Each one is an adapter with the same few
// calls, so adding another processor (Clover, Adyen, Global Payments, ...) means writing one
// more adapter here; nothing else in the app changes.

export type ProviderId = "standalone" | "simulator" | "stripe" | "square";

export interface ProviderConfig {
  /** Settings that aren't secret: location id, sandbox or production. */
  account: Record<string, string>;
  /** API keys and webhook secrets. */
  credentials: Record<string, string>;
  currency: string;
  tipping: boolean;
}

export interface Reader {
  readerId: string;
  label: string;
  online: boolean | null;
}

export interface StartRequest {
  readerId: string;
  amountCents: number;
  /** Our card payment id, so the processor's records point back at it. */
  reference: string;
  description: string;
}

export interface PaymentState {
  status: "processing" | "succeeded" | "failed" | "cancelled";
  failureMessage?: string;
  chargeId?: string;
  cardBrand?: string;
  cardLast4?: string;
  tipCents?: number;
}

/** What a provider needs to look a payment up again. */
export interface PaymentRef {
  providerPaymentId: string;
  readerId: string;
  amountCents: number;
  startedAt: Date;
}

export interface TerminalProvider {
  id: ProviderId;
  name: string;
  /** Standalone terminals aren't connected: staff run the card on their own machine. */
  connected: boolean;
  /** The settings and secrets a manager fills in to connect it. */
  fields: { key: string; label: string; secret: boolean; required: boolean; help?: string }[];
  listReaders(cfg: ProviderConfig): Promise<Reader[]>;
  startPayment(cfg: ProviderConfig, req: StartRequest): Promise<{ providerPaymentId: string }>;
  getPayment(cfg: ProviderConfig, ref: PaymentRef): Promise<PaymentState>;
  cancelPayment(cfg: ProviderConfig, ref: PaymentRef): Promise<void>;
  refund(cfg: ProviderConfig, chargeId: string, amountCents: number): Promise<void>;
  /** The processor payment id a webhook is about, once its signature checks out. */
  webhookPaymentId?(cfg: ProviderConfig, req: { headers: Record<string, string | string[] | undefined>; body: string; url: string }): string | null;
}

/** Makes HTTP calls to the processors. Swapped out in tests. */
export type PaymentsFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>;

const realFetch: PaymentsFetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, json: () => res.json() };
};

const notConnected = () => badRequest("not_connected", "Cards are taken on a standalone terminal here, so there's no reader to send to");

const standalone: TerminalProvider = {
  id: "standalone",
  name: "Standalone terminal (record only)",
  connected: false,
  fields: [],
  listReaders: async () => [],
  startPayment: async () => {
    throw notConnected();
  },
  getPayment: async () => {
    throw notConnected();
  },
  cancelPayment: async () => undefined,
  refund: async () => undefined,
};

/**
 * A pretend processor for training and demos. The card goes through a couple of seconds after
 * the amount is sent; amounts ending in 13 cents are declined, so staff can practise both.
 */
const simulator: TerminalProvider = {
  id: "simulator",
  name: "Simulator (training, no real charges)",
  connected: true,
  fields: [{ key: "delayMs", label: "Seconds before the card goes through", secret: false, required: false, help: "In milliseconds; 2500 if left empty" }],
  listReaders: async () => [
    { readerId: "sim_proshop", label: "Simulated reader 1", online: true },
    { readerId: "sim_bar", label: "Simulated reader 2", online: true },
  ],
  startPayment: async () => ({ providerPaymentId: `sim_${randomUUID()}` }),
  getPayment: async (cfg, ref) => {
    const delay = Number(cfg.account.delayMs ?? 2500);
    if (Date.now() - ref.startedAt.getTime() < delay) return { status: "processing" };
    if (ref.amountCents % 100 === 13) return { status: "failed", failureMessage: "Card declined (simulated)" };
    return { status: "succeeded", chargeId: ref.providerPaymentId, cardBrand: "visa", cardLast4: "4242", tipCents: 0 };
  },
  cancelPayment: async () => undefined,
  refund: async () => undefined,
};

function processorError(name: string, status: number, body: any): AppError {
  const message = body?.error?.message ?? body?.errors?.[0]?.detail ?? `HTTP ${status}`;
  if (status === 401 || status === 403) return new AppError(502, "processor_auth", `${name} didn't accept the API key: ${message}`);
  return new AppError(502, "processor_error", `${name}: ${message}`);
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const sameSignature = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Stripe Terminal, driven from the server: Stripe readers (WisePOS E, S700, ...) on the counter. */
function stripe(http: PaymentsFetch): TerminalProvider {
  const api = async (cfg: ProviderConfig, method: string, path: string, form?: Record<string, string | number | boolean | undefined>) => {
    const body = form
      ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))).toString()
      : undefined;
    const res = await http(`https://api.stripe.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.credentials.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      ...(body !== undefined ? { body } : {}),
    });
    const json = await res.json();
    if (res.status >= 400) throw processorError("Stripe", res.status, json);
    return json;
  };
  return {
    id: "stripe",
    name: "Stripe Terminal",
    connected: true,
    fields: [
      { key: "secretKey", label: "Secret key", secret: true, required: true, help: "Starts with sk_live_ (or sk_test_ to try it out)" },
      { key: "locationId", label: "Terminal location id", secret: false, required: false, help: "tml_..., to only list this course's readers" },
      { key: "webhookSecret", label: "Webhook signing secret", secret: true, required: false, help: "whsec_..., for instant updates; without it the app checks every couple of seconds" },
    ],
    async listReaders(cfg) {
      const q = cfg.account.locationId ? `&location=${encodeURIComponent(cfg.account.locationId)}` : "";
      const res = await api(cfg, "GET", `/terminal/readers?limit=100${q}`);
      return res.data.map((r: any) => ({ readerId: r.id, label: r.label || r.device_type, online: r.status === "online" }));
    },
    async startPayment(cfg, req) {
      const intent = await api(cfg, "POST", "/payment_intents", {
        amount: req.amountCents,
        currency: cfg.currency,
        "payment_method_types[]": "card_present",
        capture_method: "automatic",
        description: req.description,
        "metadata[card_payment_id]": req.reference,
      });
      await api(cfg, "POST", `/terminal/readers/${encodeURIComponent(req.readerId)}/process_payment_intent`, {
        payment_intent: intent.id,
        "process_config[skip_tipping]": !cfg.tipping,
      });
      return { providerPaymentId: intent.id };
    },
    async getPayment(cfg, ref) {
      const pi = await api(cfg, "GET", `/payment_intents/${encodeURIComponent(ref.providerPaymentId)}?expand[]=latest_charge`);
      const card = pi.latest_charge?.payment_method_details?.card_present;
      const details = { chargeId: pi.latest_charge?.id, cardBrand: card?.brand, cardLast4: card?.last4, tipCents: pi.amount_details?.tip?.amount ?? 0 };
      if (pi.status === "succeeded") return { status: "succeeded", ...details };
      if (pi.status === "canceled") return { status: "cancelled" };
      if (pi.status === "requires_payment_method" && pi.last_payment_error) return { status: "failed", failureMessage: pi.last_payment_error.message };
      return { status: "processing" };
    },
    async cancelPayment(cfg, ref) {
      await api(cfg, "POST", `/terminal/readers/${encodeURIComponent(ref.readerId)}/cancel_action`).catch(() => undefined);
      await api(cfg, "POST", `/payment_intents/${encodeURIComponent(ref.providerPaymentId)}/cancel`);
    },
    async refund(cfg, chargeId, amountCents) {
      await api(cfg, "POST", "/refunds", { charge: chargeId, amount: amountCents });
    },
    webhookPaymentId(cfg, req) {
      const secret = cfg.credentials.webhookSecret;
      const sig = header(req.headers, "stripe-signature");
      if (!secret || !sig) return null;
      const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=") as [string, string]));
      if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return null;
      const expected = createHmac("sha256", secret).update(`${parts.t}.${req.body}`).digest("hex");
      if (!sameSignature(expected, parts.v1)) return null;
      const event = JSON.parse(req.body);
      const obj = event.data?.object;
      if (obj?.object === "payment_intent") return obj.id;
      if (obj?.object === "terminal.reader") return obj.action?.process_payment_intent?.payment_intent ?? null;
      return null;
    },
  };
}

/** Square Terminal API: Square Terminal or Square Register devices paired to the location. */
function square(http: PaymentsFetch): TerminalProvider {
  const base = (cfg: ProviderConfig) => (cfg.account.environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");
  const api = async (cfg: ProviderConfig, method: string, path: string, body?: object) => {
    const res = await http(`${base(cfg)}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.credentials.accessToken}`, "content-type": "application/json", "square-version": "2025-01-23" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
    if (res.status >= 400) throw processorError("Square", res.status, json);
    return json;
  };
  const money = (cfg: ProviderConfig, cents: number) => ({ amount: cents, currency: cfg.currency.toUpperCase() });
  return {
    id: "square",
    name: "Square Terminal",
    connected: true,
    fields: [
      { key: "accessToken", label: "Access token", secret: true, required: true },
      { key: "locationId", label: "Location id", secret: false, required: true },
      { key: "environment", label: "Environment", secret: false, required: false, help: "production, or sandbox to try it out" },
      { key: "webhookSignatureKey", label: "Webhook signature key", secret: true, required: false, help: "For instant updates; without it the app checks every couple of seconds" },
    ],
    async listReaders(cfg) {
      const res = await api(cfg, "GET", `/v2/devices/codes?location_id=${encodeURIComponent(cfg.account.locationId ?? "")}&status=PAIRED`);
      return (res.device_codes ?? []).map((d: any) => ({ readerId: d.device_id, label: d.name || d.device_id, online: null }));
    },
    async startPayment(cfg, req) {
      const res = await api(cfg, "POST", "/v2/terminals/checkouts", {
        idempotency_key: req.reference,
        checkout: {
          amount_money: money(cfg, req.amountCents),
          reference_id: req.reference,
          note: req.description.slice(0, 500),
          device_options: { device_id: req.readerId, skip_receipt_screen: false, tip_settings: { allow_tipping: cfg.tipping } },
        },
      });
      return { providerPaymentId: res.checkout.id };
    },
    async getPayment(cfg, ref) {
      const { checkout } = await api(cfg, "GET", `/v2/terminals/checkouts/${encodeURIComponent(ref.providerPaymentId)}`);
      if (checkout.status === "COMPLETED") {
        const paymentId = checkout.payment_ids?.[0];
        const payment = paymentId ? (await api(cfg, "GET", `/v2/payments/${encodeURIComponent(paymentId)}`)).payment : undefined;
        return {
          status: "succeeded",
          chargeId: paymentId,
          cardBrand: payment?.card_details?.card?.card_brand?.toLowerCase(),
          cardLast4: payment?.card_details?.card?.last_4,
          tipCents: payment?.tip_money?.amount ?? 0,
        };
      }
      if (checkout.status === "CANCELED") {
        // The golfer pressing cancel or the card being declined both end the checkout.
        return checkout.cancel_reason === "SELLER_CANCELED" ? { status: "cancelled" } : { status: "failed", failureMessage: "The card didn't go through on the reader" };
      }
      return { status: "processing" };
    },
    async cancelPayment(cfg, ref) {
      await api(cfg, "POST", `/v2/terminals/checkouts/${encodeURIComponent(ref.providerPaymentId)}/cancel`);
    },
    async refund(cfg, chargeId, amountCents) {
      await api(cfg, "POST", "/v2/refunds", { idempotency_key: randomUUID(), payment_id: chargeId, amount_money: money(cfg, amountCents) });
    },
    webhookPaymentId(cfg, req) {
      const key = cfg.credentials.webhookSignatureKey;
      const sig = header(req.headers, "x-square-hmacsha256-signature");
      if (!key || !sig) return null;
      const expected = createHmac("sha256", key).update(req.url + req.body).digest("base64");
      if (!sameSignature(expected, sig)) return null;
      const event = JSON.parse(req.body);
      return event.data?.object?.checkout?.id ?? null;
    },
  };
}

export function providers(http: PaymentsFetch = realFetch): Record<ProviderId, TerminalProvider> {
  return { standalone, simulator, stripe: stripe(http), square: square(http) };
}
