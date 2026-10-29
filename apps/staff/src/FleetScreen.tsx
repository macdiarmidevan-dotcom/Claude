import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { Asset, AssetDetail, AssetKind, AssetPower, Client, Coworker, Priority, WorkOrder, WorkOrderArea, WorkOrderDetail, WorkOrderStatus } from "./api";
import { colors, money, type WebPress } from "./theme";

// Carts & maintenance: the cart fleet as the starter sees it (free, out on the course, down),
// machines on hour meters, and work orders for anything that needs fixing. Anyone can report a
// problem or take a cart out of service; managers add and retire carts and machines.

type Tab = "carts" | "equipment" | "orders";

const POWER: { id: AssetPower; label: string }[] = [
  { id: "gas", label: "Gas" },
  { id: "electric", label: "Electric" },
  { id: "diesel", label: "Diesel" },
  { id: "other", label: "Other" },
];
const PRIORITY: { id: Priority; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "normal", label: "Normal" },
  { id: "low", label: "Low" },
];
const PRIORITY_COLOR: Record<Priority, string> = { urgent: colors.noShow, high: colors.warn, normal: colors.muted, low: colors.muted };
const AREA: { id: WorkOrderArea; label: string }[] = [
  { id: "course", label: "Course" },
  { id: "carts", label: "Carts" },
  { id: "equipment", label: "Equipment" },
  { id: "clubhouse", label: "Clubhouse" },
  { id: "other", label: "Other" },
];
const STATUS_LABEL: Record<WorkOrderStatus, string> = { open: "Open", in_progress: "Being worked on", on_hold: "On hold", done: "Done", cancelled: "Cancelled" };
const SERVICE_LABEL = { service: "Service", repair: "Repair", inspection: "Inspection" } as const;

const shortDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const sinceTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const cents = (dollars: string) => Math.round(Number(dollars.replace(/[$,\s]/g, "") || "0") * 100);
const number = (s: string) => (s.trim() === "" ? null : Number(s));
const assetName = (a: { kind: AssetKind; number: string }) => (a.kind === "cart" ? `Cart ${a.number}` : a.number);

export function FleetScreen({ client, isManager, meId }: { client: Client; isManager: boolean; meId?: string }) {
  const [tab, setTab] = useState<Tab>("carts");
  const [asset, setAsset] = useState<string>();
  const [order, setOrder] = useState<string>();
  const [reporting, setReporting] = useState<{ asset?: Asset } | undefined>();
  // Work orders need people to assign; anyone signed in can see who works here.
  const [people, setPeople] = useState<Coworker[]>([]);
  useEffect(() => {
    client
      .coworkers()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, [client]);

  const body = reporting ? (
    <ReportProblem
      client={client}
      asset={reporting.asset}
      people={people}
      onClose={() => setReporting(undefined)}
      onSaved={(w) => (setReporting(undefined), setAsset(undefined), setTab("orders"), setOrder(w.id))}
    />
  ) : order ? (
    <WorkOrderView client={client} id={order} people={people} isManager={isManager} onBack={() => setOrder(undefined)} onAsset={(id) => (setOrder(undefined), setAsset(id))} />
  ) : asset ? (
    <AssetView client={client} id={asset} isManager={isManager} onBack={() => setAsset(undefined)} onReport={(a) => setReporting({ asset: a })} onOrder={(id) => setOrder(id)} />
  ) : tab === "carts" ? (
    <Carts client={client} isManager={isManager} onOpen={setAsset} />
  ) : tab === "equipment" ? (
    <Equipment client={client} isManager={isManager} onOpen={setAsset} />
  ) : (
    <WorkOrders client={client} meId={meId} onOpen={setOrder} onReport={() => setReporting({})} />
  );
  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={styles.tabs}>
        {(
          [
            ["carts", "Carts"],
            ["equipment", "Equipment"],
            ["orders", "Work orders"],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            role="tab"
            aria-selected={tab === id}
            onPress={() => (setTab(id), setAsset(undefined), setOrder(undefined), setReporting(undefined))}
            style={({ focused }: WebPress) => [styles.tab, tab === id && styles.tabOn, focused && styles.focus]}
          >
            <Text style={[styles.tabText, tab === id && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {body}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Carts

type CartFilter = "all" | "free" | "out" | "down" | "due";
const cartState = (c: Asset): "free" | "out" | "down" => (c.status !== "in_service" ? "down" : c.out ? "out" : "free");

function Carts({ client, isManager, onOpen }: { client: Client; isManager: boolean; onOpen: (id: string) => void }) {
  const [carts, setCarts] = useState<Asset[]>();
  const [filter, setFilter] = useState<CartFilter>("all");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    client
      .fleet("cart")
      .then(setCarts)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // Carts come and go all day; keep the board current on the starter's iPad.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [client]);

  if (!carts) return error ? <Text style={[styles.error, styles.page]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />;
  const count = (f: CartFilter) => carts.filter((c) => (f === "due" ? c.serviceDue && c.status === "in_service" : cartState(c) === f)).length;
  const shown = carts.filter((c) => filter === "all" || (filter === "due" ? c.serviceDue && c.status === "in_service" : cartState(c) === filter));
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.row}>
        <Stat label="Free" value={String(count("free"))} />
        <Stat label="Out on the course" value={String(count("out"))} />
        <Stat label="Out of service" value={String(count("down"))} tone={count("down") ? colors.noShow : undefined} />
        <Stat label="Service due" value={String(count("due"))} tone={count("due") ? colors.warn : undefined} />
      </View>
      {carts.length === 0 && !adding && (
        <View style={styles.card}>
          <Text style={styles.title}>No carts set up yet</Text>
          <Text style={styles.help}>
            Add the fleet and the starter can only hand out carts that are in service. Rounds on each cart are counted from the cart numbers given at the tee, so service comes due on its own.
            Until then any cart number is accepted.
          </Text>
          {isManager ? (
            <View style={[styles.row, { marginTop: 10 }]}>
              <Button label="Add carts" primary onPress={() => setAdding(true)} />
            </View>
          ) : (
            <Text style={[styles.help, { marginTop: 6 }]}>Ask a manager to add the carts.</Text>
          )}
        </View>
      )}
      {adding && <AddCarts client={client} onClose={() => setAdding(false)} onAdded={(list) => (setCarts(list), setAdding(false))} />}
      {carts.length > 0 && (
        <>
          <View style={[styles.row, { marginTop: 4 }]}>
            {(
              [
                ["all", `All ${carts.length}`],
                ["free", "Free"],
                ["out", "Out"],
                ["down", "Out of service"],
                ["due", "Service due"],
              ] as const
            ).map(([id, label]) => (
              <Chip key={id} label={label} on={filter === id} onPress={() => setFilter(id)} />
            ))}
            {isManager && !adding && <SmallButton label="Add carts" onPress={() => setAdding(true)} />}
          </View>
          <View style={styles.grid}>
            {shown.map((c) => (
              <CartTile key={c.id} cart={c} onPress={() => onOpen(c.id)} />
            ))}
          </View>
          {shown.length === 0 && <Text style={styles.help}>No carts here right now.</Text>}
        </>
      )}
    </ScrollView>
  );
}

function CartTile({ cart, onPress }: { cart: Asset; onPress: () => void }) {
  const state = cartState(cart);
  const tone = state === "down" ? colors.noShow : state === "out" ? colors.confirmed : colors.checkedIn;
  const line = state === "down" ? (cart.statusNote ?? "Out of service") : state === "out" ? `${cart.out!.name.split(" ").at(-1)}, ${sinceTime(cart.out!.teedOffAt)}` : "Free";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Cart ${cart.number}: ${line}${cart.serviceDue ? ", service due" : ""}`}
      onPress={onPress}
      style={({ focused, hovered }: WebPress) => [styles.tile, { borderLeftColor: tone }, state === "down" && { backgroundColor: "#fbeceb" }, hovered && { borderColor: colors.primary }, focused && styles.focus]}
    >
      <Text style={styles.tileNumber}>{cart.number}</Text>
      <Text numberOfLines={1} style={[styles.tileLine, { color: tone }]}>
        {line}
      </Text>
      {cart.serviceDue && cart.status === "in_service" && <Text style={[styles.tileLine, { color: colors.warn }]}>Service due</Text>}
    </Pressable>
  );
}

function AddCarts({ client, onClose, onAdded }: { client: Client; onClose: () => void; onAdded: (carts: Asset[]) => void }) {
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("60");
  const [model, setModel] = useState("");
  const [power, setPower] = useState<AssetPower>("gas");
  const [every, setEvery] = useState("150");
  const [error, setError] = useState<string>();
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Add carts</Text>
      <Text style={styles.help}>Numbers already in the fleet are skipped, so this is safe to run again after buying more.</Text>
      <View style={[styles.row, { marginTop: 10 }]}>
        <Field label="First number" value={from} onChange={setFrom} width={110} numeric />
        <Field label="Last number" value={to} onChange={setTo} width={110} numeric />
        <Field label="Model" value={model} onChange={setModel} placeholder="e.g. Club Car Tempo" width={220} />
        <Field label="Service every (rounds)" value={every} onChange={setEvery} width={170} numeric />
      </View>
      <View style={styles.row}>
        {POWER.slice(0, 2).map((p) => (
          <Chip key={p.id} label={p.label} on={power === p.id} onPress={() => setPower(p.id)} />
        ))}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <Button
          label={`Add carts ${from || "?"} to ${to || "?"}`}
          primary
          onPress={() =>
            client
              .addCarts({ from: Number(from), to: Number(to), model: model.trim() || null, power, serviceEvery: number(every) })
              .then((r) => onAdded(r.carts))
              .catch((e) => setError(e.message))
          }
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Equipment

function Equipment({ client, isManager, onOpen }: { client: Client; isManager: boolean; onOpen: (id: string) => void }) {
  const [list, setList] = useState<Asset[]>();
  const [adding, setAdding] = useState(false);
  const [retired, setRetired] = useState(false);
  const [error, setError] = useState<string>();
  const load = () =>
    client
      .fleet("equipment", retired)
      .then(setList)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [client, retired]);
  if (!list) return error ? <Text style={[styles.error, styles.page]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.row}>
        {isManager && !adding && <Button label="Add equipment" primary onPress={() => setAdding(true)} />}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Switch value={retired} onValueChange={setRetired} accessibilityLabel="Show retired equipment" />
          <Text style={styles.help}>Show retired</Text>
        </View>
      </View>
      {adding && <AddEquipment client={client} onClose={() => setAdding(false)} onAdded={() => (setAdding(false), load())} />}
      {list.length === 0 && !adding && (
        <Text style={styles.help}>Mowers, utility vehicles, the range picker: add each with its hour meter and how often it's serviced, and it shows here when service is due.</Text>
      )}
      {list.map((a) => (
        <Pressable key={a.id} accessibilityRole="button" onPress={() => onOpen(a.id)} style={({ focused }: WebPress) => [styles.listRow, focused && styles.focus]}>
          <View style={{ flex: 1, minWidth: 180 }}>
            <Text style={styles.strong}>{a.number}</Text>
            <Text style={styles.help}>{[a.model, a.serial && `Serial ${a.serial}`].filter(Boolean).join(" · ") || "No model on file"}</Text>
          </View>
          <View style={{ minWidth: 140 }}>
            <Text style={styles.text}>{a.hours != null ? `${a.hours} hours` : "No meter reading"}</Text>
            {a.serviceEvery && (
              <Text style={[styles.help, a.serviceDue && { color: colors.warn, fontWeight: "600" }]}>
                {a.serviceDue ? "Service due" : `Service in ${Math.max(0, Math.round((a.serviceEvery - a.sinceService) * 10) / 10)} hours`}
              </Text>
            )}
          </View>
          <StatusBadge asset={a} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function AddEquipment({ client, onClose, onAdded }: { client: Client; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [hours, setHours] = useState("");
  const [every, setEvery] = useState("");
  const [power, setPower] = useState<AssetPower>("gas");
  const [error, setError] = useState<string>();
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Add equipment</Text>
      <View style={styles.row}>
        <Field label="Name" value={name} onChange={setName} placeholder="e.g. Greens mower 2" width={220} />
        <Field label="Model" value={model} onChange={setModel} placeholder="e.g. Toro Greensmaster 3150" width={240} />
        <Field label="Serial" value={serial} onChange={setSerial} width={160} />
      </View>
      <View style={styles.row}>
        <Field label="Hour meter now" value={hours} onChange={setHours} width={140} numeric />
        <Field label="Service every (hours)" value={every} onChange={setEvery} width={170} numeric />
      </View>
      <View style={styles.row}>
        {POWER.map((p) => (
          <Chip key={p.id} label={p.label} on={power === p.id} onPress={() => setPower(p.id)} />
        ))}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <Button
          label="Add"
          primary
          disabled={!name.trim()}
          onPress={() =>
            client
              .addAsset({ kind: "equipment", number: name.trim(), model: model.trim() || null, serial: serial.trim() || null, hours: number(hours), serviceEvery: number(every), power })
              .then(onAdded)
              .catch((e) => setError(e.message))
          }
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </View>
  );
}

function StatusBadge({ asset }: { asset: Asset }) {
  const [label, tone] =
    asset.status === "retired" ? ["Retired", colors.muted] : asset.status === "out_of_service" ? ["Out of service", colors.noShow] : asset.out ? ["Out on the course", colors.confirmed] : ["In service", colors.checkedIn];
  return (
    <View style={[styles.badge, { borderColor: tone }]}>
      <Text style={[styles.badgeText, { color: tone }]}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// One cart or machine

function AssetView({
  client,
  id,
  isManager,
  onBack,
  onReport,
  onOrder,
}: {
  client: Client;
  id: string;
  isManager: boolean;
  onBack: () => void;
  onReport: (a: Asset) => void;
  onOrder: (id: string) => void;
}) {
  const [a, setA] = useState<AssetDetail>();
  const [mode, setMode] = useState<"down" | "service" | "hours" | "edit">();
  const [error, setError] = useState<string>();
  const load = () =>
    client
      .asset(id)
      .then(setA)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [client, id]);
  const act = (p: Promise<unknown>) =>
    p
      .then(() => (setMode(undefined), setError(undefined), load()))
      .catch((e) => setError(e.message));
  if (!a) return error ? <Text style={[styles.error, styles.page]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />;
  const cart = a.kind === "cart";
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="link" onPress={onBack}>
        <Text style={styles.link}>{cart ? "‹ All carts" : "‹ All equipment"}</Text>
      </Pressable>
      <View style={[styles.row, { marginTop: 10 }]}>
        <Text role="heading" style={styles.h1}>
          {assetName(a)}
        </Text>
        <StatusBadge asset={a} />
      </View>
      <Text style={styles.help}>{[a.model, a.power && POWER.find((p) => p.id === a.power)?.label, a.serial && `Serial ${a.serial}`].filter(Boolean).join(" · ")}</Text>
      {a.status === "out_of_service" && (
        <Text style={[styles.text, { color: colors.noShow, marginTop: 6 }]}>
          Out of service since {when(a.statusChangedAt)}
          {a.statusNote ? `: ${a.statusNote}` : ""}
        </Text>
      )}
      {a.out && (
        <Text style={[styles.text, { marginTop: 6 }]}>
          Out with {a.out.name}, teed off at {sinceTime(a.out.teedOffAt)}
        </Text>
      )}
      <View style={[styles.row, { marginTop: 10 }]}>
        <Stat label={cart ? "Rounds since service" : "Hours since service"} value={String(a.sinceService)} tone={a.serviceDue ? colors.warn : undefined} />
        <Stat label="Service every" value={a.serviceEvery ? `${a.serviceEvery} ${cart ? "rounds" : "hours"}` : "Not set"} />
        {!cart && <Stat label="Hour meter" value={a.hours != null ? String(a.hours) : "None"} />}
        <Stat label="Last service" value={a.lastServiceAt ? shortDate(a.lastServiceAt) : "None logged"} />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}

      {a.status !== "retired" && !mode && (
        <View style={styles.row}>
          <Button label="Report a problem" primary onPress={() => onReport(a)} />
          {a.status === "in_service" ? (
            <Button label="Take out of service" danger onPress={() => setMode("down")} />
          ) : (
            <Button label="Put back in service" onPress={() => act(client.setAssetStatus(a.id, "in_service"))} />
          )}
          <Button label="Log a service or repair" onPress={() => setMode("service")} />
          {!cart && <Button label="Update hours" onPress={() => setMode("hours")} />}
          {isManager && <Button label="Edit" onPress={() => setMode("edit")} />}
        </View>
      )}
      {a.status === "retired" && isManager && (
        <View style={styles.row}>
          <Button label="Bring back into the fleet" onPress={() => act(client.updateAsset(a.id, { retired: false }))} />
        </View>
      )}
      {mode === "down" && <TakeOut onCancel={() => setMode(undefined)} onSave={(note) => act(client.setAssetStatus(a.id, "out_of_service", note))} />}
      {mode === "service" && <LogService asset={a} onCancel={() => setMode(undefined)} onSave={(input) => act(client.logService(a.id, input))} />}
      {mode === "hours" && <UpdateHours asset={a} onCancel={() => setMode(undefined)} onSave={(h) => act(client.setHours(a.id, h))} />}
      {mode === "edit" && <EditAsset asset={a} onCancel={() => setMode(undefined)} onSave={(input) => act(client.updateAsset(a.id, input))} />}

      <View style={styles.card}>
        <Text style={styles.title}>Work orders</Text>
        {a.workOrders.length === 0 && <Text style={styles.help}>None yet.</Text>}
        {a.workOrders.map((w) => (
          <OrderRow key={w.id} order={w} onPress={() => onOrder(w.id)} />
        ))}
      </View>
      <View style={styles.card}>
        <Text style={styles.title}>Service history</Text>
        {a.service.length === 0 && <Text style={styles.help}>Nothing logged yet.</Text>}
        {a.service.map((s) => (
          <View key={s.id} style={styles.line}>
            <View style={{ flex: 1 }}>
              <Text style={styles.strong}>
                {SERVICE_LABEL[s.kind]}
                {s.workOrderNumber ? ` (work order ${s.workOrderNumber})` : ""}
              </Text>
              {s.note && <Text style={styles.text}>{s.note}</Text>}
              <Text style={styles.help}>
                {when(s.at)}
                {s.staff ? ` · ${s.staff}` : ""}
                {s.hours != null && !cart ? ` · ${s.hours} hours` : ""}
              </Text>
            </View>
            {s.costCents > 0 && <Text style={styles.text}>{money(s.costCents)}</Text>}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function TakeOut({ onCancel, onSave }: { onCancel: () => void; onSave: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <View style={styles.card}>
      <Field label="What's wrong" value={note} onChange={setNote} placeholder="e.g. Flat tire, front left" width={360} autoFocus />
      <Text style={styles.help}>The starter can't hand it out until it's put back in service. To get it fixed, report a problem too.</Text>
      <View style={[styles.row, { marginTop: 8 }]}>
        <Button label="Take out of service" danger disabled={!note.trim()} onPress={() => onSave(note.trim())} />
        <Button label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

function LogService({ asset, onCancel, onSave }: { asset: Asset; onCancel: () => void; onSave: (input: { kind: "service" | "repair" | "inspection"; note: string | null; costCents: number; hours: number | null }) => void }) {
  const [kind, setKind] = useState<"service" | "repair" | "inspection">("service");
  const [note, setNote] = useState("");
  const [cost, setCost] = useState("");
  const [hours, setHours] = useState(asset.hours != null ? String(asset.hours) : "");
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        {(Object.keys(SERVICE_LABEL) as (keyof typeof SERVICE_LABEL)[]).map((k) => (
          <Chip key={k} label={SERVICE_LABEL[k]} on={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      <View style={styles.row}>
        <Field label="What was done" value={note} onChange={setNote} placeholder={kind === "service" ? "e.g. Oil and filter, tire pressure" : ""} width={320} />
        <Field label="Cost" value={cost} onChange={setCost} placeholder="$0.00" width={110} numeric />
        {asset.kind === "equipment" && <Field label="Hour meter" value={hours} onChange={setHours} width={110} numeric />}
      </View>
      {kind === "service" && <Text style={styles.help}>A service restarts the count toward the next one.</Text>}
      <View style={[styles.row, { marginTop: 8 }]}>
        <Button label={`Log ${SERVICE_LABEL[kind].toLowerCase()}`} primary onPress={() => onSave({ kind, note: note.trim() || null, costCents: cents(cost), hours: asset.kind === "equipment" ? number(hours) : null })} />
        <Button label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

function UpdateHours({ asset, onCancel, onSave }: { asset: Asset; onCancel: () => void; onSave: (hours: number) => void }) {
  const [hours, setHours] = useState(asset.hours != null ? String(asset.hours) : "");
  return (
    <View style={styles.card}>
      <Field label="Hour meter reads" value={hours} onChange={setHours} width={160} numeric autoFocus />
      <View style={[styles.row, { marginTop: 8 }]}>
        <Button label="Save" primary disabled={number(hours) === null} onPress={() => onSave(Number(hours))} />
        <Button label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}

function EditAsset({ asset, onCancel, onSave }: { asset: Asset; onCancel: () => void; onSave: (input: Parameters<Client["updateAsset"]>[1]) => void }) {
  const [name, setName] = useState(asset.number);
  const [model, setModel] = useState(asset.model ?? "");
  const [serial, setSerial] = useState(asset.serial ?? "");
  const [every, setEvery] = useState(asset.serviceEvery ? String(asset.serviceEvery) : "");
  const [notes, setNotes] = useState(asset.notes ?? "");
  const [power, setPower] = useState<AssetPower | null>(asset.power);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Field label={asset.kind === "cart" ? "Cart number" : "Name"} value={name} onChange={setName} width={asset.kind === "cart" ? 110 : 220} />
        <Field label="Model" value={model} onChange={setModel} width={220} />
        <Field label="Serial" value={serial} onChange={setSerial} width={160} />
        <Field label={`Service every (${asset.kind === "cart" ? "rounds" : "hours"})`} value={every} onChange={setEvery} width={170} numeric />
      </View>
      <View style={styles.row}>
        {POWER.map((p) => (
          <Chip key={p.id} label={p.label} on={power === p.id} onPress={() => setPower(p.id)} />
        ))}
      </View>
      <Field label="Notes" value={notes} onChange={setNotes} width={480} />
      <View style={[styles.row, { marginTop: 8 }]}>
        <Button
          label="Save"
          primary
          disabled={!name.trim()}
          onPress={() => onSave({ number: name.trim(), model: model.trim() || null, serial: serial.trim() || null, serviceEvery: number(every), notes: notes.trim() || null, power })}
        />
        <Button label="Retire" danger onPress={() => onSave({ retired: true })} />
        <Button label="Cancel" onPress={onCancel} />
      </View>
      <Text style={styles.help}>Retiring takes it off the board and out of the starter's carts; its history stays.</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Work orders

type OrderFilter = "open" | "mine" | "closed";

function WorkOrders({ client, meId, onOpen, onReport }: { client: Client; meId?: string; onOpen: (id: string) => void; onReport: () => void }) {
  const [filter, setFilter] = useState<OrderFilter>("open");
  const [list, setList] = useState<WorkOrder[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setList(undefined);
    client
      .workOrders(filter === "closed" ? { status: "closed" } : filter === "mine" ? { status: "open", assignedTo: meId } : { status: "open" })
      .then(setList)
      .catch((e) => setError(e.message));
  }, [client, filter, meId]);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.row}>
        <Button label="Report a problem" primary onPress={onReport} />
        <Chip label="Open" on={filter === "open"} onPress={() => setFilter("open")} />
        {meId && <Chip label="Mine" on={filter === "mine"} onPress={() => setFilter("mine")} />}
        <Chip label="Done" on={filter === "closed"} onPress={() => setFilter("closed")} />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {!list ? (
        <ActivityIndicator color={colors.primary} />
      ) : list.length === 0 ? (
        <Text style={styles.help}>{filter === "closed" ? "Nothing finished yet." : "Nothing open. Report a problem when something needs fixing, on the course, a cart or in the clubhouse."}</Text>
      ) : (
        list.map((w) => <OrderRow key={w.id} order={w} onPress={() => onOpen(w.id)} boxed />)
      )}
    </ScrollView>
  );
}

function OrderRow({ order: w, onPress, boxed }: { order: WorkOrder; onPress: () => void; boxed?: boolean }) {
  const where = [w.asset ? assetName(w.asset) : AREA.find((x) => x.id === w.area)?.label, w.location].filter(Boolean).join(", ");
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ focused }: WebPress) => [boxed ? styles.listRow : styles.line, focused && styles.focus]}>
      <Text style={[styles.help, { width: 40 }]}>#{w.number}</Text>
      <View style={{ flex: 1, minWidth: 200 }}>
        <Text style={styles.strong}>{w.title}</Text>
        <Text style={styles.help}>
          {where}
          {w.assignedTo ? ` · ${w.assignedTo.name}` : " · Not assigned"}
          {w.dueDate ? ` · due ${shortDate(w.dueDate)}` : ""}
        </Text>
      </View>
      {w.overdue && <Text style={[styles.badgeText, { color: colors.noShow }]}>Overdue</Text>}
      {w.priority !== "normal" && w.status !== "done" && w.status !== "cancelled" && (
        <View style={[styles.badge, { borderColor: PRIORITY_COLOR[w.priority] }]}>
          <Text style={[styles.badgeText, { color: PRIORITY_COLOR[w.priority] }]}>{PRIORITY.find((p) => p.id === w.priority)!.label}</Text>
        </View>
      )}
      <Text style={[styles.help, { minWidth: 100, textAlign: "right" }]}>{w.status === "done" && w.completedAt ? `Done ${shortDate(w.completedAt)}` : STATUS_LABEL[w.status]}</Text>
    </Pressable>
  );
}

function ReportProblem({
  client,
  asset,
  people,
  onClose,
  onSaved,
}: {
  client: Client;
  asset?: Asset;
  people: Coworker[];
  onClose: () => void;
  onSaved: (w: WorkOrderDetail) => void;
}) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [area, setArea] = useState<WorkOrderArea>(asset ? (asset.kind === "cart" ? "carts" : "equipment") : "course");
  const [location, setLocation] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState("");
  const [down, setDown] = useState(asset?.status === "in_service");
  const [error, setError] = useState<string>();
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text role="heading" style={styles.h1}>
        Report a problem{asset ? ` with ${assetName(asset)}` : ""}
      </Text>
      <View style={styles.card}>
        <Field label="What needs fixing" value={title} onChange={setTitle} placeholder={asset ? "e.g. Brakes squeal" : "e.g. Sprinkler head broken"} width={420} autoFocus />
        <Field label="Details (optional)" value={details} onChange={setDetails} width={420} multiline />
        {!asset && (
          <>
            <Text style={[styles.label, { marginTop: 8 }]}>Where</Text>
            <View style={styles.row}>
              {AREA.map((x) => (
                <Chip key={x.id} label={x.label} on={area === x.id} onPress={() => setArea(x.id)} />
              ))}
            </View>
            <Field label="Spot (optional)" value={location} onChange={setLocation} placeholder="e.g. Hole 7, left of the green" width={300} />
          </>
        )}
        <Text style={[styles.label, { marginTop: 8 }]}>How urgent</Text>
        <View style={styles.row}>
          {PRIORITY.map((p) => (
            <Chip key={p.id} label={p.label} on={priority === p.id} onPress={() => setPriority(p.id)} />
          ))}
        </View>
        <Text style={[styles.label, { marginTop: 4 }]}>Who fixes it (optional)</Text>
        <View style={styles.row}>
          <Chip label="Not yet" on={!assignee} onPress={() => setAssignee(null)} />
          {people.map((p) => (
            <Chip key={p.id} label={p.name} on={assignee === p.id} onPress={() => setAssignee(p.id)} />
          ))}
        </View>
        <Field label="Due (optional, YYYY-MM-DD)" value={due} onChange={setDue} width={200} />
        {asset && asset.status === "in_service" && (
          <View style={[styles.row, { marginTop: 8 }]}>
            <Switch value={down} onValueChange={setDown} accessibilityLabel="Take it out of service until it's fixed" />
            <Text style={styles.text}>Take {assetName(asset).toLowerCase()} out of service until it's fixed</Text>
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={[styles.row, { marginTop: 8 }]}>
          <Button
            label="Report it"
            primary
            disabled={!title.trim()}
            onPress={() =>
              client
                .createWorkOrder({
                  title: title.trim(),
                  details: details.trim() || null,
                  area,
                  location: location.trim() || null,
                  assetId: asset?.id ?? null,
                  priority,
                  assignedTo: assignee,
                  dueDate: due.trim() || null,
                  outOfService: !!asset && down,
                })
                .then(onSaved)
                .catch((e) => setError(e.message))
            }
          />
          <Button label="Cancel" onPress={onClose} />
        </View>
      </View>
    </ScrollView>
  );
}

function WorkOrderView({
  client,
  id,
  people,
  isManager,
  onBack,
  onAsset,
}: {
  client: Client;
  id: string;
  people: Coworker[];
  isManager: boolean;
  onBack: () => void;
  onAsset: (id: string) => void;
}) {
  const [w, setW] = useState<WorkOrderDetail>();
  const [note, setNote] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [cost, setCost] = useState("");
  const [backIn, setBackIn] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string>();
  const wide = useWindowDimensions().width >= 900;
  useEffect(() => {
    client
      .workOrder(id)
      .then(setW)
      .catch((e) => setError(e.message));
  }, [client, id]);
  const act = (p: Promise<WorkOrderDetail>) =>
    p
      .then((x) => (setW(x), setNote(""), setFinishing(false), setAssigning(false), setError(undefined)))
      .catch((e) => setError(e.message));
  if (!w) return error ? <Text style={[styles.error, styles.page]}>{error}</Text> : <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />;
  const open = w.status !== "done" && w.status !== "cancelled";
  const move = (status: WorkOrderStatus) => act(client.setWorkOrderStatus(w.id, { status, note: note.trim() || null }));
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="link" onPress={onBack}>
        <Text style={styles.link}>‹ Back</Text>
      </Pressable>
      <Text style={[styles.help, { marginTop: 10 }]}>Work order {w.number}</Text>
      <Text role="heading" style={styles.h1}>
        {w.title}
      </Text>
      <View style={[styles.row, { marginTop: 4 }]}>
        <View style={[styles.badge, { borderColor: open ? colors.confirmed : colors.muted }]}>
          <Text style={[styles.badgeText, { color: open ? colors.confirmed : colors.muted }]}>{STATUS_LABEL[w.status]}</Text>
        </View>
        {w.overdue && <Text style={[styles.badgeText, { color: colors.noShow }]}>Overdue</Text>}
        {w.asset ? (
          <Pressable accessibilityRole="link" onPress={() => onAsset(w.asset!.id)}>
            <Text style={styles.link}>{assetName(w.asset)}</Text>
          </Pressable>
        ) : (
          <Text style={styles.text}>{[AREA.find((x) => x.id === w.area)?.label, w.location].filter(Boolean).join(", ")}</Text>
        )}
      </View>
      {w.details && <Text style={[styles.text, { marginTop: 6 }]}>{w.details}</Text>}
      <Text style={[styles.help, { marginTop: 6 }]}>
        Reported {when(w.createdAt)}
        {w.reportedBy ? ` by ${w.reportedBy}` : ""}
        {w.dueDate ? ` · due ${shortDate(w.dueDate)}` : ""}
        {w.costCents ? ` · cost ${money(w.costCents)}` : ""}
      </Text>

      <View style={[wide && { flexDirection: "row", gap: 16, alignItems: "flex-start" }]}>
        <View style={[styles.card, wide && { flex: 1 }]}>
          <Text style={styles.title}>Who and how urgent</Text>
          <Text style={styles.label}>Assigned to</Text>
          {assigning || !w.assignedTo ? (
            <View style={styles.row}>
              {people.map((p) => (
                <Chip key={p.id} label={p.name} on={w.assignedTo?.id === p.id} onPress={() => act(client.updateWorkOrder(w.id, { assignedTo: p.id }))} />
              ))}
              {w.assignedTo && <Chip label="No one" on={false} onPress={() => act(client.updateWorkOrder(w.id, { assignedTo: null }))} />}
            </View>
          ) : (
            <View style={styles.row}>
              <Text style={styles.strong}>{w.assignedTo.name}</Text>
              {open && <SmallButton label="Change" onPress={() => setAssigning(true)} />}
            </View>
          )}
          <Text style={styles.label}>Priority</Text>
          <View style={styles.row}>
            {PRIORITY.map((p) => (
              <Chip key={p.id} label={p.label} on={w.priority === p.id} onPress={() => open && act(client.updateWorkOrder(w.id, { priority: p.id }))} />
            ))}
          </View>
        </View>

        <View style={[styles.card, wide && { flex: 1 }]}>
          <Text style={styles.title}>Move it along</Text>
          <Field label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Part ordered, here Friday" width={360} multiline />
          {error && <Text style={styles.error}>{error}</Text>}
          {finishing ? (
            <>
              <View style={styles.row}>
                <Field label="Total cost" value={cost} onChange={setCost} placeholder="$0.00" width={120} numeric />
              </View>
              {w.asset && (
                <View style={styles.row}>
                  <Switch value={backIn} onValueChange={setBackIn} accessibilityLabel="Put it back in service" />
                  <Text style={styles.text}>Put {assetName(w.asset).toLowerCase()} back in service</Text>
                </View>
              )}
              <View style={styles.row}>
                <Button
                  label="Mark done"
                  primary
                  onPress={() => act(client.setWorkOrderStatus(w.id, { status: "done", note: note.trim() || null, costCents: cost.trim() ? cents(cost) : undefined, backInService: backIn }))}
                />
                <Button label="Back" onPress={() => setFinishing(false)} />
              </View>
            </>
          ) : open ? (
            <View style={styles.row}>
              {w.status !== "in_progress" && <Button label="Start work" primary onPress={() => move("in_progress")} />}
              <Button label="Done" primary={w.status === "in_progress"} onPress={() => setFinishing(true)} />
              {w.status !== "on_hold" && <Button label="On hold" onPress={() => move("on_hold")} />}
              <Button label="Add note" disabled={!note.trim()} onPress={() => act(client.addWorkOrderNote(w.id, note))} />
              {isManager && <Button label="Cancel work order" danger onPress={() => move("cancelled")} />}
            </View>
          ) : (
            <View style={styles.row}>
              <Button label="Open it again" onPress={() => move("open")} />
              <Button label="Add note" disabled={!note.trim()} onPress={() => act(client.addWorkOrderNote(w.id, note))} />
            </View>
          )}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>History</Text>
        <View style={styles.line}>
          <Text style={[styles.help, { width: 130 }]}>{when(w.createdAt)}</Text>
          <Text style={styles.text}>Reported{w.reportedBy ? ` by ${w.reportedBy}` : ""}</Text>
        </View>
        {w.notes.map((n) => (
          <View key={n.id} style={styles.line}>
            <Text style={[styles.help, { width: 130 }]}>{when(n.at)}</Text>
            <View style={{ flex: 1 }}>
              {n.status && <Text style={styles.strong}>{STATUS_LABEL[n.status]}</Text>}
              {n.note && <Text style={styles.text}>{n.note}</Text>}
              {n.staff && <Text style={styles.help}>{n.staff}</Text>}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------

function Field({
  label,
  value,
  onChange,
  placeholder,
  width,
  numeric,
  multiline,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number;
  numeric?: boolean;
  multiline?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <View style={{ marginBottom: 8, width: "100%", maxWidth: width }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        keyboardType={numeric ? "decimal-pad" : undefined}
        multiline={multiline}
        autoFocus={autoFocus}
        style={[styles.input, multiline && { minHeight: 64, textAlignVertical: "top" }]}
      />
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.statValue, tone && { color: tone }]}>{value}</Text>
    </View>
  );
}

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

function SmallButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={({ focused }: WebPress) => [styles.small, focused && styles.focus]}>
      <Text style={styles.smallText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 16, backgroundColor: colors.card },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { color: colors.muted, fontWeight: "600", fontSize: 14 },
  tabTextOn: { color: colors.primary },
  page: { padding: 16, maxWidth: 1100 },
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
  line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  listRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 3, backgroundColor: colors.card, marginBottom: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  tile: { width: 104, minHeight: 64, padding: 8, borderWidth: 1, borderLeftWidth: 4, borderColor: colors.border, borderRadius: 3, backgroundColor: colors.card },
  tileNumber: { fontSize: 20, fontWeight: "700", color: colors.text },
  tileLine: { fontSize: 12, fontWeight: "600" },
  badge: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 9, fontSize: 14, color: colors.text, backgroundColor: "#fff" },
  stat: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingVertical: 8, paddingHorizontal: 12, minWidth: 140, backgroundColor: "#fff" },
  statValue: { fontSize: 18, fontWeight: "700", color: colors.text },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#fff" },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 14, minHeight: 36, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  buttonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonDanger: { borderColor: colors.noShow },
  buttonText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  small: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, minHeight: 30, justifyContent: "center", backgroundColor: "#fff", alignSelf: "flex-start" },
  smallText: { color: colors.text, fontWeight: "600", fontSize: 12 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
