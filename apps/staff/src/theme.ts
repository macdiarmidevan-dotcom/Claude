import type { PressableStateCallbackType } from "react-native";

export const colors = {
  // A plain, businesslike palette: neutral grays with one blue for actions and selection.
  primary: "#1f6fd1",
  primaryLight: "#e8f0fb",
  primaryText: "#1a5bb0",
  bg: "#f2f3f5",
  card: "#ffffff",
  border: "#d8dbe0",
  text: "#1f2328",
  muted: "#5f6670",
  blocked: "#eceef1",
  checkedIn: "#2e7d4f",
  confirmed: "#2b5f9e",
  noShow: "#b3261e",
  warn: "#9a6700",
  // Sidebar, like a desktop app's navigation rail.
  rail: "#1d1f22",
  railText: "#e6e8eb",
  railMuted: "#9aa0a6",
  railActive: "#1f6fd1",
  focus: "#1a73e8",
};

/** Corner radius used everywhere: square-ish, like desktop business software. */
export const radius = 3;

/**
 * Fill colors for players on the tee sheet grid. Each has at least 4.5:1 contrast with
 * white text, and every state also has its own mark and words, so color is never the only cue.
 */
export const slotColor = {
  booked: "#2f6db5",
  prepaid: "#1e3f6e",
  checked_in: "#b25a00",
  teed_off: "#2d7a45",
  no_show: "#b3261e",
} as const;

export type SlotState = keyof typeof slotColor;

export const slotLabel: Record<SlotState, string> = {
  booked: "Booked, not paid",
  prepaid: "Booked and paid",
  checked_in: "Checked in at shop",
  teed_off: "On the course",
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
  teed_off: "#2b6e45",
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
