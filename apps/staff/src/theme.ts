import type { PressableStateCallbackType } from "react-native";

export const colors = {
  green: "#1f5130",
  greenLight: "#e5f1e8",
  greenText: "#1f5130",
  bg: "#f5f5f0",
  card: "#ffffff",
  border: "#dddcd5",
  text: "#1c1c1a",
  muted: "#6b6a63",
  blocked: "#ecebe6",
  checkedIn: "#2e7d4f",
  confirmed: "#2b5f9e",
  noShow: "#b3261e",
  warn: "#9a6700",
  // Sidebar, like a desktop app's navigation rail.
  rail: "#14281b",
  railText: "#e7efe9",
  railMuted: "#9fb5a6",
  railActive: "#2e6b42",
  focus: "#1a73e8",
};

/**
 * Fill colors for players on the tee sheet grid. Each has at least 4.5:1 contrast with
 * white text, and every state also has its own mark and words, so color is never the only cue.
 */
export const slotColor = {
  booked: "#2b5f9e",
  prepaid: "#1d3b66",
  checked_in: "#a14d00",
  teed_off: "#2b6e45",
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
  teed_off: "⛳ ",
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
  teed_off: colors.green,
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
  gift_card: "gift card",
  comp: "comp",
};

/** Pressable state on the web also says whether the pointer is over it or it has keyboard focus. */
export type WebPress = PressableStateCallbackType & { hovered?: boolean; focused?: boolean };
