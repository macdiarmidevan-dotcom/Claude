// The help center's articles. The staff app shows them, and the API hands them to the AI assistant
// as the only source it answers from, so keep them accurate when a feature changes.

export type HelpCategory = "tee-sheet" | "check-in" | "golfers" | "shop" | "events" | "reports" | "staff" | "account";

export const HELP_CATEGORIES: { id: HelpCategory; label: string; blurb: string }[] = [
  { id: "tee-sheet", label: "Tee sheet", blurb: "Walk-ins, guests, moving groups, weather" },
  { id: "check-in", label: "Check-in & payments", blurb: "Pro shop, starter, carts, refunds" },
  { id: "golfers", label: "Golfers", blurb: "Accounts, history, messages" },
  { id: "shop", label: "Gift cards & pricing", blurb: "Gift cards, house accounts, passes, rates" },
  { id: "events", label: "Leagues & events", blurb: "Weekly leagues, outings, shotguns" },
  { id: "reports", label: "Reports", blurb: "Revenue, rounds, cash drawer, maintenance" },
  { id: "staff", label: "Staff & schedule", blurb: "Shifts, swaps, staff accounts" },
  { id: "account", label: "Your account & settings", blurb: "Sign-in, stations, password, waiver" },
];

export interface HelpArticle {
  id: string;
  category: HelpCategory;
  title: string;
  /** One line shown under the title in lists. */
  summary: string;
  /** The steps or explanation, one paragraph or step per entry. */
  body: string[];
  /** Extra words people might search for. */
  keywords?: string[];
  managersOnly?: boolean;
}

export const HELP_ARTICLES: HelpArticle[] = [
  // Tee sheet
  {
    id: "read-tee-sheet",
    category: "tee-sheet",
    title: "Reading the tee sheet",
    summary: "What the colors, columns and week strip mean.",
    body: [
      "Each row is a tee time with one slot per player. Groups are colored by where they are: blue is booked but not paid, dark blue is booked and paid, orange is checked in at the pro shop, green is on the course, and red is a no-show. The color key sits above the grid.",
      "The right-hand column shows whether the time is paid or what the group still owes, plus any cart numbers.",
      "Use the week strip to change days, Today to come back, or Calendar to jump to any date. The sheet refreshes every few seconds, so changes from the pro shop show up on the starter's iPad.",
    ],
    keywords: ["colors", "legend", "calendar", "date", "day", "refresh"],
  },
  {
    id: "walk-in",
    category: "tee-sheet",
    title: "Adding a walk-in",
    summary: "Put a golfer on an open tee time.",
    body: [
      "Tap an open spot on the tee sheet. The panel shows Add a walk-in.",
      "Search the golfer by name, phone or email. If they've never been here, choose New golfer and create their account with their name, mobile phone and email.",
      "Pick the number of players, 9 or 18 holes, walking or riding, and (at the pro shop) resident or nonresident. The total updates as you go. Then tap Add to tee sheet.",
      "Every walk-in needs a golfer account, so Add to tee sheet stays grayed out until one is picked.",
    ],
    keywords: ["walk in", "walkin", "book", "add golfer", "new booking"],
  },
  {
    id: "guests",
    category: "tee-sheet",
    title: "Adding guests to a group",
    summary: "Slide a golfer's name across open spots.",
    body: [
      "Press on the golfer's name and slide it to the right across the open spots on the same row. Each spot you cross adds a guest.",
      "The group opens in the panel so you can confirm walking or riding for the guests.",
      "Guests are tied to the golfer's account but don't count toward that golfer's own spending; they still count toward course revenue.",
    ],
    keywords: ["guest", "add players", "plus one", "drag"],
  },
  {
    id: "move-remove",
    category: "tee-sheet",
    title: "Moving or removing players",
    summary: "Drag a group to a new time, or take off some players.",
    body: [
      "To move a group, press and drag it up or down to another tee time. The sheet scrolls if you drag past the top or bottom.",
      "To remove players, tap a name. Only that group opens, with each player as a button and the one you tapped already picked. Pick the players to take off and tap Remove.",
      "The golfer who booked can only come off with the whole group. Use Remove whole group for that.",
      "If you mark a group as a no-show and they turn up late, tap the group and use Undo no-show.",
    ],
    keywords: ["move", "drag", "cancel", "remove", "delete", "no-show", "no show", "late"],
  },
  {
    id: "block-time",
    category: "tee-sheet",
    title: "Blocking a tee time",
    summary: "Close a time so no one can be put on it.",
    body: [
      "Tap an open spot on the time and choose Block this time. To open it again, tap the time and choose Reopen this time.",
      "Leagues and outings with a shotgun start block their times automatically.",
    ],
    keywords: ["block", "close", "maintenance", "reserve"],
  },
  {
    id: "weather-delay",
    category: "tee-sheet",
    title: "Frost and weather delays",
    summary: "Push the tee sheet back and let golfers know.",
    body: [
      "Tap the cloud button at the top of the tee sheet, or Add, then Weather delay. Pick the reason (frost, fog, rain, lightning, heat, course or other), the time the delay starts from, and how many minutes to push back.",
      "You can text or email every golfer whose time moved. The delay can be undone from the same place.",
      "The delay moves times in this tee sheet only. Don't also move them in your booking provider (for example TeeItUp), or they'll be pushed back twice.",
    ],
    keywords: ["frost", "rain", "fog", "lightning", "delay", "push back", "weather"],
  },
  {
    id: "radar",
    category: "tee-sheet",
    title: "Weather radar",
    summary: "See rain and storms coming before you call a delay.",
    body: [
      "Open Radar in the menu to see the last hour of rain and storms around the course from the National Weather Service. It refreshes every few minutes, or tap Refresh.",
      "Open live map shows the full, zoomable radar. Each device can pick its own radar station under Radar station; River Bend uses KLOT.",
    ],
    keywords: ["radar", "weather", "storm", "rain", "lightning", "map"],
  },
  {
    id: "sync",
    category: "tee-sheet",
    title: "Syncing from your booking provider",
    summary: "Bring in tee times booked through TeeItUp or GolfNow.",
    body: [
      "Golfers keep booking through your existing provider. Managers open Sync tee sheet to bring those bookings in, either with Sync now or on a schedule from the provider's report link.",
      "Bookings that come in keep their golfer's name, players and rate so the pro shop can check them in.",
    ],
    keywords: ["teeitup", "golfnow", "import", "sync", "booking provider", "online bookings"],
    managersOnly: true,
  },
  // Check-in
  {
    id: "check-in",
    category: "check-in",
    title: "Checking a group in at the pro shop",
    summary: "Take payment and mark them checked in.",
    body: [
      "Tap the group on the tee sheet. If the golfer isn't linked to an account yet, search for them or create one.",
      "Add any items (water, snacks, balls), pick the rate if it's different, then tap Check in with the amount shown. Take payment by card, cash, gift card, house account or rain check.",
      "The group turns orange: checked in at the shop. The starter sees them as ready to go out.",
    ],
    keywords: ["check in", "checkin", "pay", "payment", "charge", "card", "cash", "pro shop"],
  },
  {
    id: "starter",
    category: "check-in",
    title: "Sending groups off as the starter",
    summary: "Check in at the tee, assign carts, collect waivers.",
    body: [
      "On the starter station, tap a group that's checked in at the shop and choose Check in at the tee.",
      "Pick their cart numbers. Each cart's driver signs the cart waiver on the screen before the cart is assigned.",
      "Send them off and the group turns green: on the course. The starter never sees resident or nonresident; rates are handled at the pro shop.",
    ],
    keywords: ["starter", "tee box", "carts", "cart number", "waiver", "sign", "send off"],
  },
  {
    id: "carts-in",
    category: "check-in",
    title: "Marking carts back in",
    summary: "Free a cart when the group finishes.",
    body: [
      "When a group comes in, tap them and mark their carts back in so the carts can go out again.",
      "Once your cart fleet is set up in Reports › Maintenance, the starter can only assign carts that are in service.",
    ],
    keywords: ["cart return", "carts in", "finished", "fleet"],
  },
  {
    id: "rain-check",
    category: "check-in",
    title: "Rain checks and refunds",
    summary: "Give credit for a round cut short, or refund it.",
    body: [
      "Tap a checked-in group's tee time and choose Rain check or Refund.",
      "A rain check gives the golfer credit for the players you pick, which they can use on a later round. You can change the amount before issuing it.",
      "A refund returns the money for the round to how it was paid.",
    ],
    keywords: ["rain check", "raincheck", "refund", "credit", "money back", "weather"],
  },
  {
    id: "card-reader",
    category: "check-in",
    title: "Card readers",
    summary: "Connecting a card terminal for payments.",
    body: [
      "Managers connect a card reader under Settings › Card payments. Until one is connected, card payments are recorded without charging a card, so you can run them on a separate terminal.",
    ],
    keywords: ["terminal", "reader", "stripe", "square", "card machine", "tap to pay"],
  },
  // Golfers
  {
    id: "golfer-accounts",
    category: "golfers",
    title: "Golfer accounts",
    summary: "Create, find and update a golfer.",
    body: [
      "Every golfer who plays needs an account with their name, mobile phone and email. Each phone number and email can only belong to one golfer.",
      "Create one the first time they check in, or from Customers › New golfer. After that, find them by searching their name, phone or email.",
      "A golfer's page shows the rounds they've played and what they've spent.",
    ],
    keywords: ["customer", "account", "profile", "new golfer", "phone", "email", "history"],
  },
  {
    id: "messages",
    category: "golfers",
    title: "Emailing and texting golfers",
    summary: "Send a note to a day's golfers, a league, or everyone.",
    body: [
      "Open Messages in the menu. Pick who it's for: everyone booked on a day, a league or outing, all golfers, house account holders, or one golfer.",
      "Choose email, text or both and write the message. Marketing messages skip golfers who opted out; notes about a round they're booked for always go.",
    ],
    keywords: ["email", "text", "sms", "message", "notify", "announcement"],
  },
  // Shop
  {
    id: "gift-cards",
    category: "shop",
    title: "Selling and using gift cards",
    summary: "Load money onto a card the golfer spends later.",
    body: [
      "Open Customers › Gift cards and sell one for any amount. Write the code on the card or hand over the printed receipt.",
      "At check-in, choose gift card as the payment and enter the code. The balance goes down by what was spent.",
    ],
    keywords: ["gift card", "voucher", "balance", "code"],
  },
  {
    id: "house-accounts",
    category: "shop",
    title: "House accounts",
    summary: "Let members charge now and pay monthly.",
    body: [
      "Open Customers › House accounts to open an account for a golfer, with an optional limit.",
      "At check-in, charge the round to their house account. Statements go out monthly and can be emailed from the account.",
    ],
    keywords: ["member", "charge", "tab", "statement", "billing", "monthly"],
  },
  {
    id: "passes",
    category: "shop",
    title: "Punch cards and loyalty points",
    summary: "Prepaid rounds and points toward a discount.",
    body: [
      "Punch cards are prepaid rounds; each check-in uses one punch.",
      "Golfers earn points on what they spend. Managers set how many points equal a dollar off.",
    ],
    keywords: ["punch card", "loyalty", "points", "rewards", "prepaid"],
  },
  {
    id: "pricing",
    category: "shop",
    title: "Green fee rates",
    summary: "Set what each round costs by day, time, residency and age.",
    body: [
      "Pricing in the menu lists every green fee and replay rate. Managers can add, edit and remove rates; everyone else can only look. It isn't shown on the starter station.",
      "Each rate covers some days (Mon–Thu, Fri–Sun and holidays, or any mix), optional hours, residents, nonresidents or everyone, and all ages or only adults, seniors or juniors. A replay rate is charged for each extra loop in the same round.",
      "A player pays the most specific rate that fits: a senior rate beats an everyone rate, and a rate with hours beats an all-day one. Bookings already made keep their price.",
    ],
    keywords: ["pricing", "price", "rates", "green fee", "twilight", "senior", "resident", "replay"],
  },
  {
    id: "carts-rentals",
    category: "shop",
    title: "Cart and rental prices",
    summary: "Price the extras golfers add to a round.",
    body: [
      "The Carts and rentals section at the bottom of Pricing lists extras such as the gas cart, pull carts and club rental, each priced per person. Managers can add, reprice and remove them.",
      "The gas cart is what riding golfers pay, so it can be repriced but not removed.",
    ],
    keywords: ["cart fee", "gas cart", "pull cart", "rental", "clubs", "extras", "price"],
  },
  {
    id: "add-ons",
    category: "account",
    title: "Add-ons: turn features on or off",
    summary: "Show only the parts of the software your course uses.",
    body: [
      "Open Add-ons in the menu to see every optional part of the software, grouped as Tee sheet, Customers, Operations, and Shop and food. A manager flips the switch to turn one on or off; everyone else can only look.",
      "Turning an add-on off hides it straight away: its menu item, tab or button goes, but nothing is deleted. Turning it back on brings everything back as it was.",
      "Tee sheet add-ons also change how the tee sheet looks: prices beside each time, the color key always showing, and the weather delay button.",
    ],
    keywords: ["add-ons", "addons", "features", "turn on", "turn off", "hide", "customize", "settings", "pro shop", "food", "bar"],
  },
  // Events
  {
    id: "leagues",
    category: "events",
    title: "Leagues and outings",
    summary: "Weekly leagues, one-day outings and shotgun starts.",
    body: [
      "Open Leagues & events and tap New league or outing. Pick a weekly league or a one-day outing, and either one group per tee time or a shotgun start.",
      "A league holds its permanent tee times each week. A shotgun blocks its times on the tee sheet and lets you set pairings.",
      "Bill the group together or let each player pay at check-in.",
    ],
    keywords: ["league", "outing", "tournament", "shotgun", "pairings", "permanent tee time", "group"],
  },
  // Reports
  {
    id: "cash-drawer",
    category: "reports",
    title: "Starting and closing the cash drawer",
    summary: "Count the drawer at the start and end of the day.",
    body: [
      "Before using the register, the pro shop counts the starting cash and taps Start the day. The tee sheet works before the count; only the register waits.",
      "At close, count the whole drawer (float included) and enter it in Reports › Cash & sales. The report shows whether the drawer is over or short.",
    ],
    keywords: ["drawer", "cash", "float", "open", "close", "end of day", "over", "short", "count"],
  },
  {
    id: "reports",
    category: "reports",
    title: "Sales reports",
    summary: "What came in today and how it was paid.",
    body: [
      "Reports › Cash & sales shows rounds, items and payments for any day. Pro shop staff see the cash drawer; managers see everything, including the accounting export for QuickBooks or Xero.",
      "Reports is hidden on the starter station.",
    ],
    keywords: ["sales", "revenue", "report", "quickbooks", "xero", "accounting", "export"],
  },
  {
    id: "manager-reports",
    category: "reports",
    title: "Revenue and rounds reports",
    summary: "How the course is doing over any stretch, compared with before.",
    body: [
      "Reports › Revenue and Reports › Rounds & tee sheet are for managers. Pick the dates at the top (today up to the year so far) and what to compare with: the period just before, or the same dates last year. Both tabs keep the dates you picked.",
      "Revenue shows total revenue, rounds, revenue per round and occupancy, a chart of revenue over time by department, and each department's share. Revenue per round covers the average green fee, everything per round, revenue per available spot (green fees spread over every open spot, filled or not) and how far below your top green fee the average round sold.",
      "Rounds & tee sheet shows how full the tee sheet was, with a heat map by weekday and hour, the split between 9 and 18 holes, walking and riding, booking sources and weekdays against weekends, and the rate mix: which green fees rounds were sold at.",
      "A round is a player booked on a tee time who wasn't a no-show. Blocked tee times don't count as open spots. Download CSV saves the numbers for a spreadsheet.",
    ],
    keywords: ["revenue", "rounds", "utilization", "occupancy", "yield", "revpatt", "rate mix", "heat map", "compare", "last year", "dashboard"],
    managersOnly: true,
  },
  {
    id: "labor-report",
    category: "reports",
    title: "Labor cost and staff pay",
    summary: "What staff hours cost against the revenue they brought in.",
    body: [
      "Set each person's pay first: Staff accounts › Pay, then choose Hourly (dollars an hour) or Salary (dollars a year). Only managers see pay.",
      "Reports › Labor shows labor cost, hours worked, revenue per labor hour and rounds per labor hour for the dates you pick, with labor cost as a share of revenue over time, cost by job and cost by person.",
      "Hourly pay counts the hours on the time clock. Hours past 40 in a Monday to Sunday week are overtime at time and a half. Salaries are spread evenly over every day. Hours count on the day the punch started, and someone still clocked in counts once they clock out.",
      "Anyone with hours but no pay set is flagged, because their hours cost nothing in the report until you set it.",
    ],
    keywords: ["labor", "payroll", "wages", "pay rate", "hourly", "salary", "overtime", "labor percent", "cost"],
    managersOnly: true,
  },
  {
    id: "inventory-report",
    category: "reports",
    title: "Pro shop inventory report",
    summary: "What sold, at what margin, and what to reorder.",
    body: [
      "Reports › Inventory (managers) shows pro shop sales and gross margin for the dates you pick, sales by category, best sellers, stock on hand at cost and at retail, and the reorder list.",
      "Margin uses each product's cost as it is today, and leaves out items with no cost set, so add costs in Pro shop › Products to see the true margin.",
      "Slow movers are products that sat on the shelf the whole period and never sold. Shrink adds up stock counts and adjustments: a negative number is stock that went missing or was damaged.",
    ],
    keywords: ["inventory", "stock", "margin", "reorder", "slow movers", "shrink", "pro shop", "cost"],
    managersOnly: true,
  },
  {
    id: "balances-report",
    category: "reports",
    title: "Payments and balances report",
    summary: "Money taken by tender, and what the course holds or is owed.",
    body: [
      "Reports › Payments & balances (managers) lists the money taken in the period by how it was paid, then what the course holds for golfers right now: gift card balances, open rain checks, punch card rounds left and loyalty points, valued in dollars. Your accountant carries those as liabilities.",
      "House accounts shows what members owe, what was charged and paid in the period, who is over their limit and the largest balances.",
      "Punch cards are valued at what each round cost on the card. Rain checks past their expiry are shown apart, as unused.",
    ],
    keywords: ["payments", "liabilities", "gift card", "house account", "owed", "balances", "rain check", "punch card", "loyalty", "accountant"],
    managersOnly: true,
  },
  {
    id: "go-live-checklist",
    category: "account",
    title: "Getting ready to go live",
    summary: "The manager's checklist for setting up the course.",
    body: [
      "Settings shows a checklist to managers. It ticks itself off as you set things up: adding staff and their pay, checking green fees, setting the sales tax rate, connecting your booking system, putting your own wording in the cart waiver, adding carts and doing a practice start-of-day.",
      "Press Open next to a step to go to the screen that fixes it. Steps marked optional, like entering pro shop stock or connecting a card reader, don't hold up going live.",
      "Replace the sample cart waiver with wording your lawyer or park district has approved before drivers sign it for real.",
    ],
    keywords: ["setup", "checklist", "onboarding", "go live", "get started", "new course", "waiver"],
    managersOnly: true,
  },
  {
    id: "maintenance",
    category: "reports",
    title: "Carts, equipment and work orders",
    summary: "Track the fleet and report problems.",
    body: [
      "Reports › Maintenance lists every cart and machine with its status.",
      "Report a problem to open a work order. Taking a cart out of service keeps the starter from assigning it until it's fixed. Log services and repairs on the cart's history.",
    ],
    keywords: ["cart", "broken", "repair", "work order", "fleet", "mower", "equipment", "service"],
  },
  // Staff
  {
    id: "schedule",
    category: "staff",
    title: "Your schedule, swaps and the time clock",
    summary: "See your shifts and trade one with a coworker.",
    body: [
      "My schedule (in the menu under your name) shows only your shifts. Staff schedule shows everyone's.",
      "To trade a shift, open it and ask a coworker to swap or take it. They accept it, and then a manager approves it (managers can turn approval off).",
      "Use Clock in and Clock out on the schedule to record your hours.",
    ],
    keywords: ["shift", "swap", "trade", "schedule", "clock in", "clock out", "hours", "time off"],
  },
  {
    id: "staff-accounts",
    category: "staff",
    title: "Adding staff",
    summary: "Give an employee their own sign-in.",
    body: [
      "Managers open Staff accounts and add the employee's name, email, role (staff or manager), job type (such as Ranger or Cart Attendant) and a starting password.",
      "Everything a person does, like checking in a group or taking a payment, is logged under their name.",
    ],
    keywords: ["employee", "new staff", "hire", "role", "manager", "job type", "permissions"],
    managersOnly: true,
  },
  // Account
  {
    id: "stations",
    category: "account",
    title: "Pro shop and starter stations",
    summary: "Which screen you see after signing in.",
    body: [
      "On the sign-in page, pick Pro shop or Starter. That decides what this device shows.",
      "Staff can't switch stations after signing in; sign out and back in to change. Managers can switch from the menu.",
    ],
    keywords: ["station", "starter", "pro shop", "switch", "sign in", "login"],
  },
  {
    id: "my-account",
    category: "account",
    title: "Your account and password",
    summary: "See your details and change your password.",
    body: [
      "Tap your name at the bottom of the menu and choose My account. It shows your name, email, role, course and station.",
      "Enter your current password and a new one (at least 8 characters) to change it. Other devices you're signed in on will ask you to sign in again.",
      "Forgot your password? Ask a manager to set a new one in Staff accounts.",
    ],
    keywords: ["password", "forgot", "reset", "profile", "email", "log out", "sign out"],
  },
  {
    id: "waiver",
    category: "account",
    title: "Editing the cart waiver",
    summary: "Change the wording drivers sign.",
    body: [
      "Managers open Settings › Cart waiver › Edit waiver wording. Each save is a new version, and every signature records which version was signed.",
    ],
    keywords: ["waiver", "liability", "terms", "cart agreement"],
    managersOnly: true,
  },
];

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "it", "do", "i", "how", "can", "my", "what", "with", "we", "you", "be", "at", "this", "that", "are", "get"]);

/** Ranks articles for a search or question: title and keyword hits count most. Best first. */
export function searchHelp(query: string, articles: HelpArticle[] = HELP_ARTICLES, limit = 8): HelpArticle[] {
  const q = words(query);
  if (!q.length) return [];
  const phrase = query.toLowerCase().trim();
  const scored = articles.map((a) => {
    const title = words(a.title);
    const keys = (a.keywords ?? []).join(" ").toLowerCase();
    const text = words([a.summary, ...a.body].join(" "));
    let score = 0;
    for (const w of q) {
      const stem = w.replace(/(ing|es|s)$/, "");
      if (title.some((t) => t.startsWith(stem))) score += 5;
      if (keys.includes(stem)) score += 4;
      score += Math.min(3, text.filter((t) => t.startsWith(stem)).length);
    }
    if (phrase.length > 3 && (a.keywords ?? []).some((k) => phrase.includes(k))) score += 6;
    return { a, score };
  });
  const top = Math.max(0, ...scored.map((s) => s.score));
  // Weak matches next to a strong one are noise: keep those scoring at least half the best.
  return scored
    .filter((s) => s.score > 0 && s.score >= top / 2)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.a);
}

/**
 * An answer without the AI assistant: the paragraph of the best-matching article that shares the
 * most words with the question, plus the matching articles to read.
 */
export function answerFromArticles(question: string, articles: HelpArticle[] = HELP_ARTICLES): { answer: string; articles: { id: string; title: string }[] } {
  const found = searchHelp(question, articles, 3);
  const best = found[0];
  if (!best) {
    return { answer: "I couldn't find a guide about that. Try different words, or use Email support and the team will get back to you.", articles: [] };
  }
  const q = words(question).map((w) => w.replace(/(ing|es|s)$/, ""));
  const hits = (p: string) => words(p).filter((w) => q.some((s) => w.startsWith(s))).length;
  const passage = best.body.reduce((a, b) => (hits(b) > hits(a) ? b : a), best.body[0]!);
  return { answer: passage, articles: found.map((a) => ({ id: a.id, title: a.title })) };
}

/** The articles as plain text, for the assistant's instructions. */
export function helpArticlesText(articles: HelpArticle[] = HELP_ARTICLES): string {
  return articles
    .map((a) => `<article id="${a.id}" title="${a.title}"${a.managersOnly ? ' managers_only="true"' : ""}>\n${a.body.join("\n")}\n</article>`)
    .join("\n\n");
}
