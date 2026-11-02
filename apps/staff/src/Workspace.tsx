import { Icon, type IconName } from "./Icon";
import { PricingScreen } from "./PricingScreen";
import { AddOnsProvider, AddOnsScreen, useAddOn } from "./AddOns";
import { addOnSettings, type AddOnKey, type AddOnSettings } from "@golf/core";
import { RadarScreen } from "./RadarScreen";
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { ApiError, createClient, type Client, type Course, type DayClose, type Me, type Settings } from "./api";
import { todayIn } from "./dates";
import { TeeSheetScreen } from "./TeeSheetScreen";
import { WaiverEditor } from "./WaiverEditor";
import { Header } from "./Header";
import { ImportScreen } from "./ImportScreen";
import { ChangePassword, StaffScreen } from "./StaffScreen";
import { GolfersScreen } from "./Golfers";
import { ScheduleScreen } from "./ScheduleScreen";
import { ProShopScreen } from "./ProShopScreen";
import { CardPaymentSettings, CardReaderProvider } from "./CardReader";
import { GiftCards, HouseAccounts } from "./AccountsScreen";
import { EventsScreen } from "./EventsScreen";
import { FoodBarScreen } from "./FoodBarScreen";
import { StationPicker } from "./SetupScreen";
import { FleetScreen } from "./FleetScreen";
import { MessagesScreen } from "./MessagesScreen";
import { ReportsScreen, StartDayForm } from "./ReportsScreen";
import { BalancesReportScreen, DEFAULT_RANGE, InventoryReportScreen, LaborReportScreen, OverviewReport, type ReportRange } from "./ManagerReports";
import { AccountMenu, FeedbackList } from "./AccountMenu";
import { HelpCenter } from "./HelpCenter";
import { SetupChecklistCard } from "./SetupChecklistCard";
import { colors, type WebPress } from "./theme";

type Section = "tee-sheet" | "radar" | "pricing" | "add-ons" | "import" | "staff" | "customers" | "events" | "food" | "messages" | "reports" | "schedule" | "inventory" | "settings" | "help";

// Sections with a group fold under one menu item, so the menu stays short.
type Group = "shop";
const GROUP_LABEL: Record<Group, string> = { shop: "Golfers & shop" };
const GROUP_ICON: Record<Group, IconName> = { shop: "users" };

const SECTION_ICON: Record<Section, IconName> = {
  "tee-sheet": "clock",
  radar: "radar",
  pricing: "tag",
  "add-ons": "box",
  import: "sync",
  staff: "user",
  customers: "users",
  messages: "message",
  inventory: "bag",
  events: "flag",
  food: "coffee",
  reports: "chart",
  schedule: "calendar",
  settings: "sliders",
  help: "help",
};

// starters: false hides a section on the starter station (managers still see it).
// inMenu: false keeps a section out of the sidebar; it opens from the account menu instead.
const ALL_SECTIONS: { id: Section; label: string; soon?: string; managers?: boolean; group?: Group; starters?: false; inMenu?: false }[] = [
  { id: "tee-sheet", label: "Tee sheet" },
  { id: "radar", label: "Radar" },
  { id: "import", label: "Sync tee sheet", managers: true },
  { id: "staff", label: "Staff accounts", managers: true },
  { id: "customers", label: "Customers" },
  { id: "messages", label: "Messages" },
  { id: "inventory", label: "Pro shop" },
  { id: "pricing", label: "Pricing", starters: false },
  { id: "add-ons", label: "Add-ons", starters: false },
  { id: "events", label: "Leagues & events" },
  { id: "food", label: "Food & bar" },
  { id: "reports", label: "Reports", starters: false },
  { id: "schedule", label: "Staff schedule" },
  { id: "settings", label: "Settings", inMenu: false },
  { id: "help", label: "Help center", inMenu: false },
];
const SECTIONS = ALL_SECTIONS;

// Sections that belong to an add-on show only while the course has it switched on.
const SECTION_ADD_ON: Partial<Record<Section, AddOnKey>> = {
  radar: "radar",
  import: "tee_sheet_sync",
  messages: "messages",
  events: "leagues",
  schedule: "staff_schedule",
  inventory: "pro_shop",
  food: "food_bar",
};
const sectionOn = (id: Section, addOns: AddOnSettings) => {
  const key = SECTION_ADD_ON[id];
  return !key || addOns[key];
};

// Below this width the menu folds away behind a button, as on phones and iPads held upright.
const RAIL_BREAKPOINT = 1024;

/** The signed-in app: a menu on the left and the chosen section beside it. */
export function Workspace({ settings, onChangeSettings, onSignOut }: { settings: Settings; onChangeSettings: (s: Settings) => void; onSignOut: () => void }) {
  const { apiUrl, courseSlug, apiKey } = settings;
  const client = useMemo(() => createClient({ apiUrl, courseSlug, apiKey }), [apiUrl, courseSlug, apiKey]);
  const { width } = useWindowDimensions();
  const rail = width >= RAIL_BREAKPOINT;

  const [section, setSection] = useState<Section>("tee-sheet");
  const [menuOpen, setMenuOpen] = useState(false);
  // The add-ons the course has switched on; the menu and screens follow them.
  const [addOns, setAddOns] = useState<AddOnSettings>(() => addOnSettings());
  const [course, setCourse] = useState<Course>();
  // Prices on the tee sheet come with the course, so it reloads when Pricing or Add-ons change.
  const refreshCourse = () => client.course().then(setCourse).catch((e) => setError(e.message));
  const [error, setError] = useState<string>();
  const [me, setMe] = useState<Me>();
  const isManager = me?.role === "manager";
  // The pro shop counts the starting cash into the drawer before the register opens. The tee sheet stays open either way.
  const [drawer, setDrawer] = useState<DayClose>();
  const proShop = settings.station === "proshop";
  const today = course ? todayIn(course.timeZone) : undefined;
  useEffect(() => {
    // Checked again on each section change, so starting the day from Reports opens the register.
    if (proShop && today) client.dayClose(today).then(setDrawer).catch(() => undefined);
  }, [client, proShop, today, section]);
  useEffect(() => {
    if (section === "reports" && !isManager && settings.station === "starter") setSection("tee-sheet");
  }, [section, isManager, settings.station]);
  const needsStart = proShop && !!drawer && !drawer.open && !drawer.close;
  const startDay = (title: string) => (
    <>
      <Header title={title} onOpenMenu={openMenu} subtitle="Start the day first" />
      <ScrollView contentContainerStyle={{ padding: 16, maxWidth: 720 }}>
        <StartDayForm client={client} date={today!} onOpened={setDrawer} />
      </ScrollView>
    </>
  );
  const [editingWaiver, setEditingWaiver] = useState(false);
  // Moving between a golfer's account and their bookings on the tee sheet.
  const [jumpTo, setJumpTo] = useState<{ date: string; bookingId: string }>();
  const [golferId, setGolferId] = useState<string>();
  // "My schedule" in the account menu opens the schedule showing only your own shifts.
  const [onlyMine, setOnlyMine] = useState(false);
  // The page they opened the help center from, sent along with questions and support requests.
  const [helpFrom, setHelpFrom] = useState<string | null>(null);
  const openGolfer = (id: string) => {
    setGolferId(id);
    setSection("customers");
  };
  const openBooking = (b: { bookingId: string; startsAt: string }) => {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: course?.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(b.startsAt));
    setJumpTo({ date, bookingId: b.bookingId });
    setSection("tee-sheet");
  };

  useEffect(() => {
    refreshCourse();
    client.addOnSettings().then(setAddOns).catch(() => undefined);
    client
      .me()
      .then(setMe)
      .catch((e) => {
        // An expired sign-in or a turned-off account goes back to the sign-in screen.
        if (e instanceof ApiError && e.status === 401) onSignOut();
      });
  }, [client]);

  // A section whose add-on was just switched off goes back to the tee sheet.
  useEffect(() => {
    if (!sectionOn(section, addOns)) setSection("tee-sheet");
  }, [section, addOns]);

  // Ends the session on the server too, so the token can't be used again.
  const signOut = () => {
    client.logout().catch(() => undefined);
    onSignOut();
  };

  const go = (s: Section) => {
    setSection(s);
    if (s !== "schedule") setOnlyMine(false);
    if (s === "customers") setGolferId(undefined);
    setMenuOpen(false);
  };

  const menu = (
    <SideMenu
      courseName={course?.name ?? "Loading…"}
      section={section}
      onGo={go}
      settings={settings}
      onChangeSettings={onChangeSettings}
      isManager={isManager}
      addOns={addOns}
      me={me}
      onSignOut={signOut}
      onClose={rail ? undefined : () => setMenuOpen(false)}
      account={
        <AccountMenu
          client={client}
          course={course}
          me={me}
          isManager={isManager}
          station={settings.station}
          page={SECTIONS.find((s) => s.id === section)?.label ?? section}
          onGo={(to) => {
            setOnlyMine(to === "schedule");
            if (to === "help" && section !== "help") setHelpFrom(SECTIONS.find((s) => s.id === section)?.label ?? null);
            go(to);
          }}
          onSignOut={signOut}
        />
      }
    />
  );
  const openMenu = rail ? undefined : () => setMenuOpen(true);
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <AddOnsProvider value={addOns}>
    <CardReaderProvider client={client} terminalId={settings.terminalId}>
    <View style={styles.page}>
      {rail && menu}
      <View style={styles.main}>
        {needsStart && section === "inventory" ? (
          startDay("Pro shop")
        ) : section === "tee-sheet" ? (
          course ? (
            <TeeSheetScreen
              client={client}
              course={course}
              station={settings.station}
              onSignOut={signOut}
              onOpenMenu={openMenu}
              onOpenGolfer={openGolfer}
              jumpTo={jumpTo}
              isManager={isManager}
            />
          ) : (
            <Header title="Tee sheet" onOpenMenu={openMenu} subtitle={error ?? "Loading…"} />
          )
        ) : section === "import" ? (
          <>
            <Header title="Sync tee sheet" onOpenMenu={openMenu} />
            <ImportScreen client={client} />
          </>
        ) : section === "customers" ? (
          <>
            <Header title="Customers" onOpenMenu={openMenu} />
            <CustomersArea
              key={golferId ?? "search"}
              client={client}
              isManager={isManager}
              customers={<GolfersScreen client={client} openId={golferId} onOpenBooking={openBooking} isManager={isManager} />}
            />
          </>
        ) : section === "staff" ? (
          <>
            <Header title="Staff accounts" onOpenMenu={openMenu} />
            <StaffScreen client={client} me={me?.user ?? null} />
          </>
        ) : section === "schedule" ? (
          <>
            <Header title="Staff schedule" onOpenMenu={openMenu} />
            {course && <ScheduleScreen key={String(onlyMine)} client={client} me={me} timeZone={course.timeZone} startMine={onlyMine} />}
          </>
        ) : section === "events" ? (
          <>
            <Header title="Leagues & events" onOpenMenu={openMenu} />
            {course && <EventsScreen client={client} isManager={isManager} timeZone={course.timeZone} courseHoles={course.holes} />}
          </>
        ) : section === "food" ? (
          <>
            <Header title="Food & bar" onOpenMenu={openMenu} />
            {course && <FoodBarScreen client={client} isManager={isManager} timeZone={course.timeZone} />}
          </>
        ) : section === "messages" ? (
          <>
            <Header title="Messages" onOpenMenu={openMenu} />
            {course && <MessagesScreen client={client} isManager={isManager} timeZone={course.timeZone} />}
          </>
        ) : section === "reports" ? (
          <>
            <Header title="Reports" onOpenMenu={openMenu} />
            {course && <ReportsArea client={client} me={me} isManager={isManager} timeZone={course.timeZone} onOpenStaff={() => setSection("staff")} />}
          </>
        ) : section === "inventory" ? (
          <>
            <Header title="Pro shop" onOpenMenu={openMenu} />
            {course && <ProShopScreen client={client} me={me} timeZone={course.timeZone} />}
          </>
        ) : section === "radar" ? (
          <>
            <Header title="Radar" onOpenMenu={openMenu} subtitle="Weather around the course" />
            <RadarScreen station={settings.radarStation} onChangeStation={(radarStation) => onChangeSettings({ ...settings, radarStation })} />
          </>
        ) : section === "pricing" ? (
          <>
            <Header title="Pricing" onOpenMenu={openMenu} subtitle="Green fees, replays, carts and rentals" />
            <PricingScreen client={client} isManager={isManager} onChanged={refreshCourse} />
          </>
        ) : section === "add-ons" ? (
          <>
            <Header title="Add-ons" onOpenMenu={openMenu} subtitle="Turn features on or off for your course" />
            <AddOnsScreen client={client} isManager={isManager} settings={addOns} onChange={setAddOns} />
          </>
        ) : section === "help" ? (
          <>
            <Header title="Help center" onOpenMenu={openMenu} />
            <HelpCenter client={client} me={me} isManager={isManager} page={helpFrom} />
          </>
        ) : section === "settings" ? (
          <>
            <Header title="Settings" onOpenMenu={openMenu} />
            <ScrollView contentContainerStyle={styles.content}>
              {isManager && (
                <SetupChecklistCard
                  client={client}
                  onOpen={(where) => {
                    const target: Partial<Record<typeof where, Section>> = { staff: "staff", pricing: "pricing", sync: "import", inventory: "inventory", reports: "reports" };
                    const section = target[where];
                    // The pro shop is an add-on; if it's off, its settings are turned on in Add-ons first.
                    if (section) go(sectionOn(section, addOns) ? section : "add-ons");
                  }}
                />
              )}
              <Text style={styles.label}>This device is for</Text>
              {isManager ? (
                <View style={{ maxWidth: 360 }}>
                  <StationPicker value={settings.station} onChange={(station) => onChangeSettings({ ...settings, station })} />
                </View>
              ) : (
                <Text style={[styles.help, { fontWeight: "700", color: colors.text }]}>{STATION_LABEL[settings.station]}</Text>
              )}
              <Text style={styles.help}>
                The pro shop takes payment and checks groups in. The starter sends them off the first tee and assigns carts.
                {isManager
                  ? " Managers can switch between the two at any time."
                  : ` This was picked when you signed in; to use this device for the ${settings.station === "proshop" ? "starter" : "pro shop"}, sign out and pick it on the sign-in page.`}
              </Text>
              <Text style={[styles.label, { marginTop: 24 }]}>Card payments</Text>
              <CardPaymentSettings
                client={client}
                isManager={isManager}
                terminalId={settings.terminalId}
                onPickTerminal={(terminalId) => onChangeSettings({ ...settings, terminalId })}
              />
              <Text style={[styles.label, { marginTop: 24 }]}>Cart waiver</Text>
              {isManager ? (
                <Pressable accessibilityRole="button" onPress={() => setEditingWaiver(true)} style={styles.button}>
                  <Text style={styles.buttonText}>Edit waiver wording</Text>
                </Pressable>
              ) : (
                <Text style={styles.help}>Only a manager can change the waiver wording.</Text>
              )}
              <Text style={[styles.label, { marginTop: 24 }]}>Signed in</Text>
              <Text style={styles.help}>
                {me?.user ? `${me.user.name} (${me.user.email})` : "Shared device key"} · {isManager ? "Manager" : "Staff"} · {course?.name}
              </Text>
              {isManager && (
                <>
                  <Text style={[styles.label, { marginTop: 24 }]}>Feedback from staff</Text>
                  <FeedbackList client={client} />
                </>
              )}
              {me?.user && (
                <>
                  <Text style={[styles.label, { marginTop: 24 }]}>Your password</Text>
                  <ChangePassword client={client} />
                </>
              )}
              <Pressable accessibilityRole="button" onPress={signOut} style={[styles.button, styles.buttonQuiet]}>
                <Text style={[styles.buttonText, { color: colors.text }]}>Sign out</Text>
              </Pressable>
            </ScrollView>
          </>
        ) : (
          <>
            <Header title={current.label} onOpenMenu={openMenu} />
            <View style={styles.content}>
              <Text style={styles.soonTitle}>{current.label} is coming soon</Text>
              <Text style={styles.help}>{current.soon}</Text>
            </View>
          </>
        )}
      </View>

      {!rail && (
        <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          <View style={styles.drawerWrap}>
            {menu}
            <Pressable accessibilityRole="button" accessibilityLabel="Close menu" style={styles.backdrop} onPress={() => setMenuOpen(false)} />
          </View>
        </Modal>
      )}
      {editingWaiver && <WaiverEditor client={client} onClose={() => setEditingWaiver(false)} />}
    </View>
    </CardReaderProvider>
    </AddOnsProvider>
  );
}

function SideMenu(props: {
  courseName: string;
  section: Section;
  onGo: (s: Section) => void;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  isManager: boolean;
  addOns: AddOnSettings;
  me?: Me;
  onSignOut: () => void;
  onClose?: () => void;
  /** The name at the foot of the menu, which opens the account menu. */
  account: React.ReactNode;
}) {
  const { courseName, section, onGo, settings, onChangeSettings, isManager, onClose, account } = props;
  const currentGroup = SECTIONS.find((s) => s.id === section)?.group;
  const [openGroup, setOpenGroup] = useState<Group | undefined>(currentGroup);
  // Going to a section in a group (from a golfer link, say) opens that group.
  useEffect(() => {
    if (currentGroup) setOpenGroup(currentGroup);
  }, [currentGroup]);
  const visible = SECTIONS.filter((s) => sectionOn(s.id, props.addOns) && (!s.managers || isManager) && (s.starters !== false || isManager || settings.station !== "starter") && s.inMenu !== false);
  const item = (s: (typeof SECTIONS)[number], nested?: boolean) => {
    const on = s.id === section;
    return (
      <Pressable
        key={s.id}
        accessibilityRole="link"
        accessibilityState={{ selected: on }}
        aria-current={on ? "page" : undefined}
        onPress={() => onGo(s.id)}
        style={({ hovered, focused }: WebPress) => [
          styles.navItem,
          nested && { paddingLeft: 41 },
          on && styles.navItemOn,
          hovered && !on && { backgroundColor: "#1d3826" },
          focused && styles.focusRing,
        ]}
      >
        {!nested && <Icon name={SECTION_ICON[s.id]} size={17} color={on ? "#fff" : colors.railMuted} />}
        <Text style={[styles.navText, on && { fontWeight: "700", color: "#fff" }]}>{s.label}</Text>
        {s.soon && <Text style={styles.soonTag}>Soon</Text>}
      </Pressable>
    );
  };
  return (
    <View role="navigation" aria-label="Main menu" style={styles.rail}>
      <View style={styles.railTop}>
        <View style={styles.courseBox}>
          <Icon name="flag" size={16} color={colors.railMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.brand}>Course</Text>
            <Text style={styles.course} numberOfLines={2}>{courseName}</Text>
          </View>
        </View>
        {onClose && (
          <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} style={styles.menuButton}>
            <Text style={[styles.menuIcon, { color: colors.railText }]}>✕</Text>
          </Pressable>
        )}
      </View>
      <View style={{ paddingHorizontal: 12, marginBottom: 12 }}>
        {/* Staff stay on the station they signed in to; managers can switch. */}
        {isManager ? (
          <StationPicker dark value={settings.station} onChange={(station) => onChangeSettings({ ...settings, station })} />
        ) : (
          <Text style={styles.stationTag}>{STATION_LABEL[settings.station]}</Text>
        )}
      </View>
      <ScrollView style={{ flex: 1 }}>
        {visible.map((s, i) => {
          if (!s.group) return item(s);
          // A group shows once, where its first section is.
          if (visible[i - 1]?.group === s.group) return null;
          const group = s.group;
          const open = openGroup === group;
          const holdsCurrent = currentGroup === group;
          return (
            <View key={group}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                onPress={() => setOpenGroup(open ? undefined : group)}
                style={({ hovered, focused }: WebPress) => [styles.navItem, hovered && { backgroundColor: "#1d3826" }, focused && styles.focusRing]}
              >
                <Icon name={GROUP_ICON[group]} size={17} color={holdsCurrent && !open ? "#fff" : colors.railMuted} />
                <Text style={[styles.navText, holdsCurrent && !open && { fontWeight: "700", color: "#fff" }]}>{GROUP_LABEL[group]}</Text>
                <Text style={styles.groupArrow}>{open ? "▾" : "▸"}</Text>
              </Pressable>
              {open && visible.filter((x) => x.group === group).map((x) => item(x, true))}
            </View>
          );
        })}
      </ScrollView>
      {account}
    </View>
  );
}

/** Customers: golfer accounts, with gift cards and house accounts in tabs beside them. */
function CustomersArea({ client, isManager, customers }: { client: Client; isManager: boolean; customers: React.ReactNode }) {
  const [part, setPart] = useState<"customers" | "gift" | "house">("customers");
  const gift = useAddOn("gift_cards");
  const house = useAddOn("house_accounts");
  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={styles.tabs}>
        {(
          [
            ["customers", "Customers"],
            ["gift", "Gift cards"],
            ["house", "House accounts"],
          ] as const
        ).filter(([id]) => (id !== "gift" || gift) && (id !== "house" || house)).map(([id, label]) => (
          <Pressable
            key={id}
            role="tab"
            aria-selected={part === id}
            onPress={() => setPart(id)}
            style={({ focused }: WebPress) => [styles.tab, part === id && styles.tabOn, focused && styles.focusRing]}
          >
            <Text style={[styles.tabText, part === id && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {part === "customers" || (part === "gift" && !gift) || (part === "house" && !house) ? customers : part === "gift" ? <GiftCards client={client} isManager={isManager} /> : <HouseAccounts client={client} isManager={isManager} />}
    </View>
  );
}

/** Reports: the money side (cash drawer and sales) and maintenance (carts, equipment, work orders). */
function ReportsArea({ client, me, isManager, timeZone, onOpenStaff }: { client: Client; me: Me | undefined; isManager: boolean; timeZone: string; onOpenStaff: () => void }) {
  const [part, setPart] = useState<"revenue" | "rounds" | "labor" | "inventory" | "balances" | "sales" | "maintenance">(isManager ? "revenue" : "sales");
  const [range, setRange] = useState<ReportRange>(DEFAULT_RANGE);
  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={styles.tabs}>
        {(
          [
            ...(isManager
              ? ([
                  ["revenue", "Revenue"],
                  ["rounds", "Rounds & tee sheet"],
                  ["labor", "Labor"],
                  ["inventory", "Inventory"],
                  ["balances", "Payments & balances"],
                ] as const)
              : []),
            ["sales", "Cash & sales"],
            ["maintenance", "Maintenance"],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            role="tab"
            aria-selected={part === id}
            onPress={() => setPart(id)}
            style={({ focused }: WebPress) => [styles.tab, part === id && styles.tabOn, focused && styles.focusRing]}
          >
            <Text style={[styles.tabText, part === id && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {part === "revenue" || part === "rounds" ? (
        <OverviewReport client={client} timeZone={timeZone} view={part} range={range} onRange={setRange} />
      ) : part === "labor" ? (
        <LaborReportScreen client={client} timeZone={timeZone} range={range} onRange={setRange} onOpenStaff={onOpenStaff} />
      ) : part === "inventory" ? (
        <InventoryReportScreen client={client} timeZone={timeZone} range={range} onRange={setRange} />
      ) : part === "balances" ? (
        <BalancesReportScreen client={client} timeZone={timeZone} range={range} onRange={setRange} />
      ) : part === "sales" ? <ReportsScreen client={client} me={me} timeZone={timeZone} /> : <FleetScreen client={client} isManager={isManager} meId={me?.user?.id} />}
    </View>
  );
}

const STATION_LABEL: Record<Settings["station"], string> = { proshop: "Pro shop", starter: "Starter" };

const styles = StyleSheet.create({
  stationTag: { color: "#fff", backgroundColor: colors.primary, borderRadius: 3, paddingVertical: 8, fontSize: 14, fontWeight: "600", textAlign: "center" },
  page: { flex: 1, flexDirection: "row", backgroundColor: colors.bg },
  tabs: { flexDirection: "row", flexWrap: "wrap", borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 16, backgroundColor: colors.card },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { fontSize: 14, color: colors.muted, fontWeight: "600" },
  tabTextOn: { color: colors.primary },
  main: { flex: 1, minWidth: 0 },
  rail: { width: 240, backgroundColor: colors.rail, paddingTop: 16, height: "100%" },
  railTop: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 12, marginBottom: 14 },
  courseBox: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: "#3a3e44", borderRadius: 3, paddingHorizontal: 10, paddingVertical: 8 },
  brand: { color: colors.railMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  course: { color: colors.railText, fontSize: 14, fontWeight: "700", marginTop: 1 },
  navItem: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36, paddingHorizontal: 12, marginHorizontal: 8, borderRadius: 3 },
  navItemOn: { backgroundColor: colors.railActive },
  navIcon: { color: colors.railText, fontSize: 14, width: 20, textAlign: "center" },
  navText: { color: colors.railText, fontSize: 14, flex: 1 },
  groupArrow: { color: colors.railMuted, fontSize: 12 },
  soonTag: { color: colors.railMuted, fontSize: 11, fontWeight: "600" },
  focusRing: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
  drawerWrap: { flex: 1, flexDirection: "row" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  menuButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 3 },
  menuIcon: { fontSize: 18, color: colors.text },
  content: { padding: 16, maxWidth: 640 },
  label: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
  help: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  soonTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 8 },
  button: { backgroundColor: colors.primary, borderRadius: 3, paddingHorizontal: 12, minHeight: 36, justifyContent: "center", alignSelf: "flex-start", marginTop: 4 },
  buttonQuiet: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, marginTop: 12 },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});
