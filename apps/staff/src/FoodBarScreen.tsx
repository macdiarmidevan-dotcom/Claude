import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { Client, GolferAccount, PrepStation, PrepTicket, Product, Sale, SalePaymentMethod, SheetBooking, Tab, TabItem, TabItemInput, TabLocation } from "./api";
import { CardChargeModal, useCardReader } from "./CardReader";
import { todayIn } from "./dates";
import { useSearch } from "./Golfers";
import { colors, formatTime, money, type WebPress } from "./theme";

// Food and bar: open tabs for golfers and tables, orders that go straight to the kitchen or bar
// screen, and paying the tab at the end like any register sale.

type View_ = "tabs" | PrepStation;

const LOCATIONS: { id: TabLocation; label: string }[] = [
  { id: "grill", label: "Grill" },
  { id: "bar", label: "Bar" },
  { id: "turn", label: "At the turn" },
  { id: "cart", label: "Beverage cart" },
];
const PAY: { method: SalePaymentMethod; label: string }[] = [
  { method: "card", label: "Card" },
  { method: "cash", label: "Cash" },
  { method: "gift_card", label: "Gift card" },
  { method: "comp", label: "Comp" },
];
const STATUS: Record<TabItem["status"], string> = { sent: "Being made", ready: "Ready", served: "Served", void: "Taken off" };
const minutesSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
const parseCents = (text: string) => {
  const clean = text.replace(/[$,\s]/g, "");
  return /^\d+(\.\d{0,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
};

export function FoodBarScreen({ client, isManager, timeZone }: { client: Client; isManager: boolean; timeZone: string }) {
  const [view, setView] = useState<View_>("tabs");
  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={styles.tabs}>
        {(
          [
            ["tabs", "Open tabs"],
            ["kitchen", "Kitchen screen"],
            ["bar", "Bar screen"],
          ] as const
        ).map(([id, label]) => (
          <Pressable key={id} role="tab" aria-selected={view === id} onPress={() => setView(id)} style={({ focused }: WebPress) => [styles.tab, view === id && styles.tabOn, focused && styles.focus]}>
            <Text style={[styles.tabText, view === id && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {view === "tabs" ? <Tabs client={client} isManager={isManager} timeZone={timeZone} /> : <PrepScreen key={view} client={client} station={view} />}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Tabs

function Tabs({ client, isManager, timeZone }: { client: Client; isManager: boolean; timeZone: string }) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [list, setList] = useState<Tab[]>();
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [paid, setPaid] = useState<Sale>();
  const [error, setError] = useState<string>();
  const load = () => client.tabs().then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    client.products().then(setProducts).catch(() => undefined);
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [client]);
  const tab = list?.find((t) => t.id === selected);
  const update = (t: Tab) => setList((l) => (t.status === "open" ? (l ?? []).map((x) => (x.id === t.id ? t : x)) : (l ?? []).filter((x) => x.id !== t.id)));

  const listPane = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.page}>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {paid && (
        <View role="status" style={[styles.card, { borderColor: colors.checkedIn, marginTop: 0, marginBottom: 10 }]}>
          <Text style={styles.strong}>
            Paid {money(paid.totalCents)} · receipt #{paid.number}
          </Text>
          <SmallButton label="OK" onPress={() => setPaid(undefined)} />
        </View>
      )}
      {opening ? (
        <OpenTabForm
          client={client}
          timeZone={timeZone}
          onClose={() => setOpening(false)}
          onOpened={(t) => {
            setOpening(false);
            setList((l) => [t, ...(l ?? [])]);
            setSelected(t.id);
          }}
        />
      ) : (
        <Button label="Open a tab" primary onPress={() => setOpening(true)} />
      )}
      {!list ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : list.length === 0 ? (
        <Text style={[styles.help, { marginTop: 12 }]}>No open tabs.</Text>
      ) : (
        <View style={{ marginTop: 12 }}>
          {list.map((t) => (
            <Pressable
              key={t.id}
              accessibilityRole="button"
              accessibilityState={{ selected: t.id === selected }}
              onPress={() => setSelected(t.id)}
              style={({ hovered, focused }: WebPress) => [styles.listRow, t.id === selected && styles.listRowOn, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.strong}>{t.name}</Text>
                <Text style={styles.help}>
                  {LOCATIONS.find((l) => l.id === t.location)?.label}
                  {t.teeTime ? ` · ${formatTime(new Date(t.teeTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }))} tee time` : ""} · {minutesSince(t.openedAt)} min
                </Text>
                {t.waiting > 0 && <Text style={[styles.help, { color: colors.warn }]}>{t.waiting} waiting on the kitchen or bar</Text>}
              </View>
              <Text style={styles.strong}>{money(t.subtotalCents + t.taxCents)}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );

  const detail = tab && (
    <TabView
      key={tab.id}
      client={client}
      tab={tab}
      products={products}
      isManager={isManager}
      wide={wide}
      onBack={() => setSelected(undefined)}
      onChanged={update}
      onPaid={(sale) => {
        setPaid(sale);
        setSelected(undefined);
        load();
      }}
    />
  );

  if (!wide) return detail ?? listPane;
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ width: 360, borderRightWidth: 1, borderColor: colors.border }}>{listPane}</View>
      <View style={{ flex: 1 }}>{detail ?? <Text style={[styles.help, { padding: 20 }]}>Pick a tab, or open a new one.</Text>}</View>
    </View>
  );
}

function OpenTabForm({ client, timeZone, onClose, onOpened }: { client: Client; timeZone: string; onClose: () => void; onOpened: (t: Tab) => void }) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState<TabLocation>("grill");
  const [groups, setGroups] = useState<(SheetBooking & { localTime: string })[]>();
  const [golfer, setGolfer] = useState<GolferAccount>();
  const { results } = useSearch(client, golfer ? "" : name);
  const [error, setError] = useState<string>();
  useEffect(() => {
    // Groups on the course today, so food at the turn goes on the right golfer's tab.
    client
      .teeSheet(todayIn(timeZone))
      .then((d) =>
        setGroups(d.teeTimes.flatMap((t) => t.bookings.filter((b) => b.status === "checked_in" || b.status === "teed_off").map((b) => ({ ...b, localTime: t.localTime })))),
      )
      .catch(() => setGroups([]));
  }, [client, timeZone]);
  const open = (input: { name?: string; golferId?: string; bookingId?: string; location?: TabLocation }) =>
    client
      .openTab({ location, ...input })
      .then(onOpened)
      .catch((e) => setError(e.message));
  return (
    <View style={[styles.card, { marginTop: 0 }]}>
      <Text role="heading" aria-level={2} style={styles.title}>
        Open a tab
      </Text>
      <View style={styles.row}>
        {LOCATIONS.map((l) => (
          <Chip key={l.id} label={l.label} on={location === l.id} onPress={() => setLocation(l.id)} />
        ))}
      </View>
      {golfer ? (
        <View style={styles.row}>
          <Text style={styles.strong}>{golfer.name}</Text>
          <SmallButton label="Change" onPress={() => setGolfer(undefined)} />
        </View>
      ) : (
        <TextInput accessibilityLabel="Tab name" placeholder="Name or table, e.g. Table 4 (or search golfers)" value={name} onChangeText={setName} style={styles.input} />
      )}
      {!golfer &&
        results?.slice(0, 3).map((g) => (
          <Pressable key={g.id} accessibilityRole="button" onPress={() => setGolfer(g)} style={({ hovered }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }]}>
            <Text style={styles.text}>
              {g.name} <Text style={styles.help}>· golfer account, earns points</Text>
            </Text>
          </Pressable>
        ))}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.row, { marginTop: 8 }]}>
        <Button
          label="Open tab"
          primary
          disabled={!golfer && !name.trim()}
          onPress={() => open(golfer ? { golferId: golfer.id } : { name: name.trim() })}
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
      {groups && groups.length > 0 && (
        <>
          <Text style={[styles.label, { marginTop: 10 }]}>Or a group on the course today</Text>
          {groups.map((b) => (
            <Pressable
              key={b.id}
              accessibilityRole="button"
              onPress={() => open({ bookingId: b.id, location: location === "grill" ? "turn" : location })}
              style={({ hovered }: WebPress) => [styles.result, hovered && { backgroundColor: colors.primaryLight }]}
            >
              <Text style={styles.text}>
                {formatTime(b.localTime)} · {b.customerName} <Text style={styles.help}>({b.players})</Text>
              </Text>
            </Pressable>
          ))}
        </>
      )}
    </View>
  );
}

function TabView({
  client,
  tab,
  products,
  isManager,
  wide,
  onBack,
  onChanged,
  onPaid,
}: {
  client: Client;
  tab: Tab;
  products: Product[];
  isManager: boolean;
  wide: boolean;
  onBack: () => void;
  onChanged: (t: Tab) => void;
  onPaid: (s: Sale) => void;
}) {
  const menu = useMemo(() => products.filter((p) => p.active && p.foodBev), [products]);
  const categories = useMemo(() => [...new Set(menu.map((p) => p.category))], [menu]);
  const [category, setCategory] = useState<string>();
  const [order, setOrder] = useState<{ product: Product; quantity: number; note: string }[]>([]);
  const [other, setOther] = useState({ description: "", price: "" });
  const [method, setMethod] = useState<SalePaymentMethod>("card");
  const [charging, setCharging] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reader = useCardReader();
  const shown = menu.filter((p) => !category || p.category === category);
  const totalCents = tab.subtotalCents + tab.taxCents;
  const kept = tab.items.filter((i) => i.status !== "void");

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  const add = (p: Product) =>
    setOrder((o) => (o.some((x) => x.product.id === p.id) ? o.map((x) => (x.product.id === p.id ? { ...x, quantity: x.quantity + 1 } : x)) : [...o, { product: p, quantity: 1, note: "" }]));
  async function send() {
    const lines: TabItemInput[] = order.map((o) => ({ productId: o.product.id, quantity: o.quantity, note: o.note.trim() || null }));
    const cents = parseCents(other.price);
    if (other.description.trim() && cents !== undefined) lines.push({ description: other.description.trim(), unitCents: cents, quantity: 1, station: "kitchen" });
    const t = await run(() => client.addTabItems(tab.id, lines));
    if (t) {
      onChanged(t);
      setOrder([]);
      setOther({ description: "", price: "" });
    }
  }
  async function pay(cardPaymentId?: string) {
    const r = await run(() => client.closeTab(tab.id, method, cardPaymentId));
    if (r) onPaid(r.sale);
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {!wide && (
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8} style={{ marginBottom: 10 }}>
          <Text style={styles.link}>‹ Open tabs</Text>
        </Pressable>
      )}
      <Text role="heading" style={styles.h1}>
        {tab.name}
      </Text>
      <Text style={styles.help}>
        {LOCATIONS.find((l) => l.id === tab.location)?.label}
        {tab.golfer ? ` · ${tab.golfer.name}'s account (earns points)` : ""} · opened {minutesSince(tab.openedAt)} min ago{tab.openedBy ? ` by ${tab.openedBy}` : ""}
      </Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}

      <View style={styles.card}>
        <Text style={styles.title}>Add to the order</Text>
        <View style={styles.row}>
          <Chip label="All" on={!category} onPress={() => setCategory(undefined)} />
          {categories.map((c) => (
            <Chip key={c} label={c} on={category === c} onPress={() => setCategory(c)} />
          ))}
        </View>
        <View style={styles.menu}>
          {shown.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={`Add ${p.name}, ${money(p.priceCents)}`}
              onPress={() => add(p)}
              style={({ hovered, pressed, focused }: WebPress) => [styles.menuItem, (hovered || pressed) && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
            >
              <Text style={styles.strong} numberOfLines={2}>
                {p.name}
              </Text>
              <Text style={styles.help}>
                {money(p.priceCents)}
                {p.station ? ` · ${p.station === "kitchen" ? "kitchen" : "bar"}` : ""}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={[styles.row, { marginTop: 8 }]}>
          <TextInput accessibilityLabel="Other item" placeholder="Something not on the menu" value={other.description} onChangeText={(description) => setOther({ ...other, description })} style={[styles.input, { flex: 1, minWidth: 180 }]} />
          <TextInput accessibilityLabel="Other item price" placeholder="Price" value={other.price} onChangeText={(price) => setOther({ ...other, price })} keyboardType="decimal-pad" style={[styles.input, { width: 90 }]} />
        </View>
        {order.length > 0 && (
          <View style={{ marginTop: 6 }}>
            {order.map((o, i) => (
              <View key={o.product.id} style={styles.line}>
                <View style={styles.stepper}>
                  <SmallButton label="−" onPress={() => setOrder(order.flatMap((x, j) => (j !== i ? [x] : x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : [])))} />
                  <Text style={[styles.strong, { minWidth: 22, textAlign: "center" }]}>{o.quantity}</Text>
                  <SmallButton label="+" onPress={() => add(o.product)} />
                </View>
                <Text style={[styles.text, { flex: 1 }]}>{o.product.name}</Text>
                {o.product.station && (
                  <TextInput
                    accessibilityLabel={`Note for ${o.product.name}`}
                    placeholder="Note, e.g. no onions"
                    value={o.note}
                    onChangeText={(note) => setOrder(order.map((x, j) => (j === i ? { ...x, note } : x)))}
                    style={[styles.input, { width: 170, paddingVertical: 6 }]}
                  />
                )}
              </View>
            ))}
          </View>
        )}
        <Button
          label={busy ? "Sending…" : order.some((o) => o.product.station) ? "Send order" : "Add to tab"}
          primary
          disabled={busy || (!order.length && !(other.description.trim() && parseCents(other.price) !== undefined))}
          onPress={send}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>On the tab</Text>
        {tab.items.length === 0 && <Text style={styles.help}>Nothing yet.</Text>}
        {tab.items.map((i) => (
          <View key={i.id} style={styles.line}>
            <Text style={[styles.text, { flex: 1 }, i.status === "void" && { color: colors.muted, textDecorationLine: "line-through" }]}>
              {i.quantity} × {i.description}
              {i.note ? <Text style={styles.help}> · {i.note}</Text> : null}
            </Text>
            {i.station && <Badge status={i.status} />}
            <Text style={[styles.strong, { width: 70, textAlign: "right" }, i.status === "void" && { color: colors.muted }]}>{money(i.totalCents)}</Text>
            {i.status !== "void" && (!i.station || i.status === "sent" || isManager) ? (
              <SmallButton label="Remove" onPress={() => run(() => client.voidTabItem(tab.id, i.id)).then((t) => t && onChanged(t))} />
            ) : (
              <View style={{ width: 66 }} />
            )}
          </View>
        ))}
        <View style={[styles.line, { borderBottomWidth: 0 }]}>
          <Text style={[styles.help, { flex: 1 }]}>Tax</Text>
          <Text style={styles.text}>{money(tab.taxCents)}</Text>
        </View>
        <View style={[styles.line, { borderBottomWidth: 0 }]}>
          <Text style={[styles.strong, { flex: 1, fontSize: 16 }]}>Total</Text>
          <Text style={[styles.strong, { fontSize: 16 }]}>{money(totalCents)}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Pay the tab</Text>
        <View style={styles.row}>
          {PAY.map((m) => (
            <Chip key={m.method} label={m.label} on={method === m.method} onPress={() => setMethod(m.method)} />
          ))}
        </View>
        {method === "comp" && <Text style={styles.help}>A comp is given away, so no tax is charged.</Text>}
        {tab.waiting > 0 && <Text style={[styles.help, { color: colors.warn }]}>{tab.waiting} items are still being made. Paying takes them off the kitchen and bar screens.</Text>}
        <View style={styles.row}>
          <Button
            label={`Pay ${money(method === "comp" ? tab.subtotalCents : totalCents)}`}
            primary
            disabled={busy || !kept.length}
            onPress={() => (method === "card" && reader.terminal ? setCharging(true) : pay())}
          />
          {voiding ? (
            <>
              <TextInput accessibilityLabel="Why void it" placeholder="Why, e.g. opened by mistake" value={reason} onChangeText={setReason} style={[styles.input, { flex: 1, minWidth: 180 }]} />
              <Button label="Void tab" danger disabled={!reason.trim()} onPress={() => run(() => client.voidTab(tab.id, reason)).then((t) => t && onChanged(t))} />
            </>
          ) : (
            (isManager || !kept.length) && <Button label="Void tab" onPress={() => setVoiding(true)} />
          )}
        </View>
      </View>
      {charging && reader.terminal && (
        <CardChargeModal
          client={client}
          terminal={reader.terminal}
          amountCents={totalCents}
          description={`Tab: ${tab.name}`}
          onPaid={(p) => {
            setCharging(false);
            pay(p.id);
          }}
          onClose={() => setCharging(false)}
        />
      )}
    </ScrollView>
  );
}

function Badge({ status }: { status: TabItem["status"] }) {
  const tone = status === "sent" ? colors.warn : status === "ready" ? colors.checkedIn : colors.muted;
  return (
    <View style={[styles.badge, { borderColor: tone }]}>
      <Text style={[styles.badgeText, { color: tone }]}>{STATUS[status]}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Kitchen and bar screens

/**
 * What the kitchen or bar has to make, one ticket per order, oldest first. Tap an item when it's
 * made; "Served" clears the ticket. Refreshes on its own so it can stay up on a screen in the back.
 */
function PrepScreen({ client, station }: { client: Client; station: PrepStation }) {
  const [tickets, setTickets] = useState<PrepTicket[]>();
  const [error, setError] = useState<string>();
  const [, tick] = useState(0);
  const load = () =>
    client
      .prep(station)
      .then((t) => (setTickets(t), setError(undefined)))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const timer = setInterval(() => (load(), tick((n) => n + 1)), 5_000);
    return () => clearInterval(timer);
  }, [client, station]);
  const set = (ids: string[], status: "sent" | "ready" | "served") =>
    client
      .setPrepStatus(ids, status)
      .then(load)
      .catch((e) => setError(e.message));

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.help}>
        {station === "kitchen" ? "Food ordered on any tab shows here as soon as it's sent." : "Drinks to pour show here as soon as they're ordered."} Tap an item when it's made.
      </Text>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!tickets ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : tickets.length === 0 ? (
        <Text style={[styles.strong, { marginTop: 20 }]}>Nothing waiting.</Text>
      ) : (
        <View style={styles.tickets}>
          {tickets.map((t) => {
            const age = minutesSince(t.orderedAt);
            const allReady = t.items.every((i) => i.status === "ready");
            return (
              <View key={t.key} style={[styles.ticket, age >= 15 && { borderColor: colors.noShow }, allReady && { borderColor: colors.checkedIn }]}>
                <View style={[styles.row, { justifyContent: "space-between", marginBottom: 2 }]}>
                  <Text style={[styles.strong, { fontSize: 16 }]}>{t.tabName}</Text>
                  <Text style={[styles.strong, { color: age >= 15 ? colors.noShow : age >= 8 ? colors.warn : colors.muted }]}>{age} min</Text>
                </View>
                <Text style={[styles.help, { marginBottom: 6 }]}>
                  {LOCATIONS.find((l) => l.id === t.location)?.label}
                  {t.by ? ` · ${t.by}` : ""}
                </Text>
                {t.items.map((i) => (
                  <Pressable
                    key={i.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: i.status === "ready" }}
                    onPress={() => set([i.id], i.status === "ready" ? "sent" : "ready")}
                    style={({ hovered, focused }: WebPress) => [styles.prepItem, hovered && { backgroundColor: colors.primaryLight }, focused && styles.focus]}
                  >
                    <Text style={[styles.prepText, i.status === "ready" && { color: colors.checkedIn }]}>
                      {i.status === "ready" ? "✓ " : ""}
                      {i.quantity} × {i.description}
                    </Text>
                    {i.note && <Text style={[styles.strong, { color: colors.noShow }]}>{i.note}</Text>}
                  </Pressable>
                ))}
                <View style={[styles.row, { marginTop: 8, marginBottom: 0 }]}>
                  {!allReady && <SmallButton label="All ready" onPress={() => set(t.items.map((i) => i.id), "ready")} />}
                  <SmallButton label="Served" primary onPress={() => set(t.items.map((i) => i.id), "served")} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={onPress} style={({ focused }: WebPress) => [styles.chip, on && styles.chipOn, focused && styles.focus]}>
      <Text style={[styles.chipText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function Button({ label, onPress, primary, danger, disabled }: { label: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ focused }: WebPress) => [styles.button, primary && styles.buttonPrimary, danger && styles.buttonDanger, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton(props: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={({ focused }: WebPress) => [styles.small, props.primary && styles.buttonPrimary, focused && styles.focus]}>
      <Text style={[styles.smallText, props.primary && { color: "#fff" }]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 16, backgroundColor: colors.card },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { color: colors.muted, fontWeight: "600", fontSize: 14 },
  tabTextOn: { color: colors.primary },
  page: { padding: 16 },
  h1: { fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 },
  title: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 8 },
  text: { color: colors.text, fontSize: 14 },
  strong: { fontSize: 14, fontWeight: "600", color: colors.text },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  label: { fontSize: 12, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  link: { color: colors.primary, fontWeight: "600", textDecorationLine: "underline", fontSize: 14 },
  error: { color: colors.noShow, marginVertical: 6 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 14, backgroundColor: colors.card, marginTop: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  line: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  listRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 3, backgroundColor: colors.card, marginBottom: 6 },
  listRowOn: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  result: { paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 3, marginBottom: 4, backgroundColor: "#fff" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  menu: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  menuItem: { width: 150, minHeight: 64, borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 10, backgroundColor: "#fff", justifyContent: "space-between" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 4 },
  badge: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start", marginTop: 4 },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonDanger: { borderColor: colors.noShow },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  small: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, minHeight: 30, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  smallText: { color: colors.text, fontWeight: "600", fontSize: 12 },
  tickets: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 12 },
  ticket: { width: 260, flexGrow: 1, maxWidth: 360, borderWidth: 2, borderColor: colors.border, borderRadius: 3, padding: 12, backgroundColor: colors.card },
  prepItem: { paddingVertical: 6, paddingHorizontal: 4, borderRadius: 3 },
  prepText: { fontSize: 17, fontWeight: "600", color: colors.text },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
