import type { PressableStateCallbackType } from "react-native";

export const colors = {
  // Forest green chrome around a near-white work area, with square corners and thin lines.
  primary: "#1d6b47",
  primaryLight: "#e3f0e8",
  primaryText: "#17573a",
  bg: "#f4f6f8",
  card: "#ffffff",
  border: "#c9d0d8",
  /** Lines between rows inside a table, lighter than the borders around it. */
  rowLine: "#e2e6eb",
  /** Header strips inside cards: table headings, stats and week bars. */
  strip: "#eef1f4",
  text: "#121821",
  muted: "#4a5566",
  /** Example text inside an empty input. */
  placeholder: "#a3a9b1",
  blocked: "#d5dae0",
  checkedIn: "#15703f",
  confirmed: "#2563c9",
  noShow: "#b42323",
  warn: "#8a4200",
  // The top bar (and the phone menu): dark forest green.
  rail: "#0f1f18",
  railText: "#e8eee9",
  railMuted: "#aebfb4",
  railActive: "#1d6b47",
  railHover: "#1a3226",
  railLine: "#22382c",
  /** The bar under the menu with the page title and its buttons. */
  toolbar: "#172a21",
  toolbarLine: "#2f4a3b",
  /** The line under the open menu item. */
  railAccent: "#4caf7d",
  focus: "#1a73e8",
};

/** Corner radius used everywhere: square corners, like desktop business software. */
export const radius = 0;

/**
 * Fill colors for players on the tee sheet grid. Each has at least 4.5:1 contrast with
 * white text, and every state also has its own mark and words, so color is never the only cue.
 */
export const slotColor = {
  booked: "#2563c9",
  prepaid: "#173f86",
  checked_in: "#b4580e",
  teed_off: "#157a4a",
  no_show: "#b42323",
} as const;

export type SlotState = keyof typeof slotColor;

export const slotLabel: Record<SlotState, string> = {
  booked: "Booked, not paid",
  prepaid: "Booked and paid",
  checked_in: "Checked in at shop",
  teed_off: "On the course",
  no_show: "No-show",
};

/** Short names for the color key above the tee sheet. */
export const slotShort: Record<SlotState, string> = {
  booked: "Booked",
  prepaid: "Paid",
  checked_in: "Checked in",
  teed_off: "On course",
  no_show: "No-show",
};

export const slotMark: Record<SlotState, string> = {
  booked: "",
  prepaid: "$ ",
  checked_in: "✓ ",
  teed_off: "» ",
  no_show: "✕ ",
};

export const statusLabel: Record<string, string> = {
  confirmed: "Booked",
  checked_in: "Checked in at shop",
  teed_off: "On the course",
  no_show: "No-show",
  cancelled: "Cancelled",
};

export const statusColor: Record<string, string> = {
  confirmed: colors.confirmed,
  checked_in: colors.checkedIn,
  teed_off: "#157a4a",
  no_show: colors.noShow,
  cancelled: colors.muted,
};

export const formatTime = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${suffix}`;
};

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const paymentMethodLabel: Record<string, string> = {
  card: "card",
  cash: "cash",
  prepaid: "prepaid online",
  punch_card: "punch card",
  season_pass: "season pass",
  loyalty: "loyalty points",
  rain_check: "rain check",
  gift_card: "gift card",
  comp: "comp",
};

/** Pressable state on the web also says whether the pointer is over it or it has keyboard focus. */
export type WebPress = PressableStateCallbackType & { hovered?: boolean; focused?: boolean };
