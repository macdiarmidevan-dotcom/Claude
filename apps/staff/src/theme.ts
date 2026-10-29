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
