// Add-ons: parts of the software each course can switch on or off to suit how it runs.
// Turning one off hides it in the staff app; nothing is deleted, so turning it back on
// brings back everything as it was.

export type AddOnKey =
  | "radar"
  | "weather_delays"
  | "tee_sheet_prices"
  | "color_key_open"
  | "tee_sheet_sync"
  | "messages"
  | "gift_cards"
  | "house_accounts"
  | "leagues"
  | "staff_schedule"
  | "pro_shop"
  | "food_bar";

export type AddOnGroup = "tee_sheet" | "customers" | "operations" | "shop";

export interface AddOnInfo {
  key: AddOnKey;
  group: AddOnGroup;
  name: string;
  description: string;
  /** Whether a course has it before a manager changes anything. */
  defaultOn: boolean;
}

export const ADD_ON_GROUPS: { id: AddOnGroup; label: string }[] = [
  { id: "tee_sheet", label: "Tee sheet" },
  { id: "customers", label: "Customers" },
  { id: "operations", label: "Operations" },
  { id: "shop", label: "Shop and food" },
];

export const ADD_ONS: AddOnInfo[] = [
  { key: "radar", group: "tee_sheet", name: "Weather radar", description: "A Radar page with the National Weather Service radar loop around the course.", defaultOn: true },
  { key: "weather_delays", group: "tee_sheet", name: "Weather delays", description: "Push the tee sheet back for frost, rain or lightning and tell the golfers whose times moved.", defaultOn: true },
  { key: "tee_sheet_prices", group: "tee_sheet", name: "Prices on the tee sheet", description: "Show each tee time's standard green fee next to the time.", defaultOn: true },
  { key: "color_key_open", group: "tee_sheet", name: "Color key always showing", description: "Keep the key to the player colors open above the tee sheet instead of behind a button.", defaultOn: false },
  { key: "tee_sheet_sync", group: "tee_sheet", name: "Booking provider sync", description: "Pull tee times and bookings in from TeeItUp, GolfNow or a CSV export.", defaultOn: true },
  { key: "messages", group: "customers", name: "Golfer messaging", description: "Email and text golfers: everyone on a day, a league, account holders or one golfer.", defaultOn: true },
  { key: "gift_cards", group: "customers", name: "Gift cards", description: "Sell, reload and redeem gift cards at check-in and the register.", defaultOn: true },
  { key: "house_accounts", group: "customers", name: "House accounts", description: "Let members charge to an account and get a monthly statement.", defaultOn: true },
  { key: "leagues", group: "operations", name: "Leagues and events", description: "Weekly leagues, permanent tee times, outings and shotgun starts with group billing.", defaultOn: true },
  { key: "staff_schedule", group: "operations", name: "Staff schedule", description: "Shifts, the time clock, and shift swaps between employees.", defaultOn: true },
  { key: "pro_shop", group: "shop", name: "Pro shop register", description: "A register for merchandise, with products, stock counts, sales history, passes and loyalty points.", defaultOn: false },
  { key: "food_bar", group: "shop", name: "Food and bar", description: "Open tabs, kitchen and bar order screens, and turn-stand sales tied to the golfer.", defaultOn: false },
];

export type AddOnSettings = Record<AddOnKey, boolean>;

export const ADD_ON_KEYS = ADD_ONS.map((a) => a.key);

/** Every add-on's setting: the saved choices over the defaults. */
export function addOnSettings(saved: Partial<Record<string, boolean>> = {}): AddOnSettings {
  return Object.fromEntries(ADD_ONS.map((a) => [a.key, saved[a.key] ?? a.defaultOn])) as AddOnSettings;
}
