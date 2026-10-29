import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { ApiError, createClient, type Course, type DayClose, type Me, type Settings } from "./api";
import { todayIn } from "./dates";
import { StationPicker } from "./SetupScreen";
import { TeeSheetScreen } from "./TeeSheetScreen";
import { WaiverEditor } from "./WaiverEditor";
import { Header } from "./Header";
import { ImportScreen } from "./ImportScreen";
import { ChangePassword, StaffScreen } from "./StaffScreen";
import { GolfersScreen } from "./Golfers";
import { ScheduleScreen } from "./ScheduleScreen";
import { ProShopScreen } from "./ProShopScreen";
import { CardPaymentSettings, CardReaderProvider } from "./CardReader";
import { ReportsScreen, StartDayForm } from "./ReportsScreen";
import { colors, type WebPress } from "./theme";

type Section = "tee-sheet" | "import" | "staff" | "customers" | "reports" | "schedule" | "inventory" | "settings";

// starters: false hides a section on the starter station (managers still see it).
const SECTIONS: { id: Section; label: string; soon?: string; managers?: boolean; starters?: false }[] = [
  { id: "tee-sheet", label: "Tee sheet" },
  { id: "import", label: "Sync tee sheet", managers: true },
  { id: "staff", label: "Staff accounts", managers: true },
  { id: "customers", label: "Golfers" },
  { id: "reports", label: "Reports", starters: false },
  { id: "schedule", label: "Staff schedule" },
  { id: "inventory", label: "Pro shop" },
  { id: "settings", label: "Settings" },
];

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
  const [course, setCourse] = useState<Course>();
  const [error, setError] = useState<string>();
  const [me, setMe] = useState<Me>();
  const isManager = me?.role === "manager";
  // The pro shop counts the starting cash into the drawer before the tee sheet or register opens.
  const [drawer, setDrawer] = useState<DayClose>();
  const proShop = settings.station === "proshop";
  const today = course ? todayIn(course.timeZone) : undefined;
  useEffect(() => {
    // Checked again on each section change, so starting the day from Reports opens the tee sheet.
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
    client.course().then(setCourse).catch((e) => setError(e.message));
    client
      .me()
      .then(setMe)
      .catch((e) => {
        // An expired sign-in or a turned-off account goes back to the sign-in screen.
        if (e instanceof ApiError && e.status === 401) onSignOut();
      });
  }, [client]);

  // Ends the session on the server too, so the token can't be used again.
  const signOut = () => {
    client.logout().catch(() => undefined);
    onSignOut();
  };

  const go = (s: Section) => {
    setSection(s);
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
      me={me}
      onSignOut={signOut}
      onClose={rail ? undefined : () => setMenuOpen(false)}
    />
  );
  const openMenu = rail ? undefined : () => setMenuOpen(true);
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <CardReaderProvider client={client} terminalId={settings.terminalId}>
    <View style={styles.page}>
      {rail && menu}
      <View style={styles.main}>
        {needsStart && (section === "tee-sheet" || section === "inventory") ? (
          startDay(section === "tee-sheet" ? "Tee sheet" : "Pro shop")
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
            <Header title="Golfers" onOpenMenu={openMenu} />
            <GolfersScreen key={golferId ?? "search"} client={client} openId={golferId} onOpenBooking={openBooking} />
          </>
        ) : section === "staff" ? (
          <>
            <Header title="Staff accounts" onOpenMenu={openMenu} />
            <StaffScreen client={client} me={me?.user ?? null} />
          </>
        ) : section === "schedule" ? (
          <>
            <Header title="Staff schedule" onOpenMenu={openMenu} />
            {course && <ScheduleScreen client={client} me={me} timeZone={course.timeZone} />}
          </>
        ) : section === "reports" ? (
          <>
            <Header title="Reports" onOpenMenu={openMenu} />
            {course && <ReportsScreen client={client} me={me} timeZone={course.timeZone} />}
          </>
        ) : section === "inventory" ? (
          <>
            <Header title="Pro shop" onOpenMenu={openMenu} />
            {course && <ProShopScreen client={client} me={me} timeZone={course.timeZone} />}
          </>
        ) : section === "settings" ? (
          <>
            <Header title="Settings" onOpenMenu={openMenu} />
            <ScrollView contentContainerStyle={styles.content}>
              <Text style={styles.label}>This device is for</Text>
              <View style={{ maxWidth: 360 }}>
                <StationPicker value={settings.station} onChange={(station) => onChangeSettings({ ...settings, station })} />
              </View>
              <Text style={styles.help}>The pro shop takes payment and checks groups in. The starter sends them off the first tee and assigns carts.</Text>
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
  );
}

function SideMenu(props: {
  courseName: string;
  section: Section;
  onGo: (s: Section) => void;
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  isManager: boolean;
  me?: Me;
  onSignOut: () => void;
  onClose?: () => void;
}) {
  const { courseName, section, onGo, settings, onChangeSettings, isManager, me, onSignOut, onClose } = props;
  return (
    <View role="navigation" aria-label="Main menu" style={styles.rail}>
      <View style={styles.railTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>Tee Sheet</Text>
          <Text style={styles.course} numberOfLines={2}>{courseName}</Text>
        </View>
        {onClose && (
          <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} style={styles.menuButton}>
            <Text style={[styles.menuIcon, { color: colors.railText }]}>✕</Text>
          </Pressable>
        )}
      </View>
      <View style={{ paddingHorizontal: 12, marginBottom: 6 }}>
        <StationPicker dark value={settings.station} onChange={(station) => onChangeSettings({ ...settings, station })} />
      </View>
      <ScrollView style={{ flex: 1 }}>
        {SECTIONS.filter((s) => (!s.managers || isManager) && (s.starters !== false || isManager || settings.station !== "starter")).map((s) => {
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
                on && styles.navItemOn,
                hovered && !on && { backgroundColor: "#1d3826" },
                focused && styles.focusRing,
              ]}
            >
              <Text style={[styles.navText, on && { fontWeight: "700", color: "#fff" }]}>{s.label}</Text>
              {s.soon && <Text style={styles.soonTag}>Soon</Text>}
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.railFoot}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text style={styles.railName} numberOfLines={1}>{me?.user?.name ?? "Shared device"}</Text>
          <Text style={styles.railMuted}>{isManager ? "Manager" : "Staff"}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onSignOut} hitSlop={8}>
          <Text style={styles.railLink}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: "row", backgroundColor: colors.bg },
  main: { flex: 1, minWidth: 0 },
  rail: { width: 240, backgroundColor: colors.rail, paddingTop: 16, height: "100%" },
  railTop: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 12, marginBottom: 14 },
  brand: { color: colors.railMuted, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  course: { color: colors.railText, fontSize: 15, fontWeight: "700", marginTop: 2 },
  navItem: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36, paddingHorizontal: 12, marginHorizontal: 8, borderRadius: 3 },
  navItemOn: { backgroundColor: colors.railActive },
  navIcon: { color: colors.railText, fontSize: 14, width: 20, textAlign: "center" },
  navText: { color: colors.railText, fontSize: 14, flex: 1 },
  soonTag: { color: colors.railMuted, fontSize: 11, fontWeight: "600" },
  railFoot: { borderTopWidth: 1, borderColor: "#2a4433", padding: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  railMuted: { color: colors.railMuted, fontSize: 12 },
  railName: { color: colors.railText, fontSize: 13, fontWeight: "700" },
  railLink: { color: colors.railText, fontSize: 13, fontWeight: "600", textDecorationLine: "underline" },
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
