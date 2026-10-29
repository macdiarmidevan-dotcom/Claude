import { useCallback, useEffect, useMemo, useState } from "react";
import { PassSetup } from "./PassSetup";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { Client, GolferAccount, Me, Product, ProductInput, Sale, SalePaymentMethod, SalesDay, StockMovement } from "./api";
import { addDays, dayParts, todayIn } from "./dates";
import { useSearch } from "./Golfers";
import { CardChargeModal, useCardReader } from "./CardReader";
import { colors, money, radius, type WebPress } from "./theme";

type Tab = "register" | "inventory" | "sales" | "passes";

const METHODS: { id: SalePaymentMethod; label: string }[] = [
  { id: "card", label: "Card" },
  { id: "cash", label: "Cash" },
  { id: "gift_card", label: "Gift card" },
  { id: "comp", label: "Comp" },
];
const methodLabel = (m: string) => METHODS.find((x) => x.id === m)?.label ?? m;

const REASON: Record<StockMovement["reason"], string> = {
  sale: "Sold",
  refund: "Refunded",
  receive: "Received",
  count: "Counted",
  adjust: "Adjusted",
};

/** Dollars typed by staff ("24.99") to cents, or undefined when it isn't a price. */
const toCents = (text: string) => {
  const t = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
};
const dollars = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));

/**
 * The pro shop: a register to ring up sales, the product list with stock counts, and the day's
 * sales. Everyone can sell and receive deliveries; managers set prices, count stock and refund.
 */
export function ProShopScreen({ client, me, timeZone }: { client: Client; me: Me | undefined; timeZone: string }) {
  const isManager = me?.role === "manager";
  const [tab, setTab] = useState<Tab>("register");
  const [products, setProducts] = useState<Product[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    client
      .products({ all: true })
      .then((p) => {
        setProducts(p);
        setError(undefined);
      })
      .catch((e) => setError(e.message));
  }, [client]);
  useEffect(load, [load]);

  const low = (products ?? []).filter((p) => p.low).length;
  const tabs: { id: Tab; label: string }[] = [
    { id: "register", label: "Register" },
    { id: "inventory", label: low ? `Inventory (${low} low)` : "Inventory" },
    { id: "sales", label: "Today's sales" },
    { id: "passes", label: "Passes & points" },
  ];

  return (
    <View style={{ flex: 1 }}>
      <View role="tablist" style={[styles.tabs, { paddingHorizontal: 16 }]}>
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onPress={() => setTab(t.id)}
            style={({ focused }: WebPress) => [styles.tab, tab === t.id && styles.tabOn, focused && styles.focus]}
          >
            <Text style={[styles.tabText, tab === t.id && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text role="alert" style={[styles.error, { marginHorizontal: 16 }]}>{error}</Text>}
      {!products ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : tab === "register" ? (
        <Register client={client} products={products.filter((p) => p.active)} onSold={load} />
      ) : tab === "inventory" ? (
        <Inventory client={client} products={products} isManager={isManager} onChanged={load} />
      ) : tab === "sales" ? (
        <SalesView client={client} isManager={isManager} timeZone={timeZone} onRefunded={load} />
      ) : (
        <PassSetup client={client} isManager={isManager} />
      )}
    </View>
  );
}

type TicketLine = { key: string; productId?: string; description: string; unitCents: number; quantity: number; taxable: boolean };

function Register({ client, products, onSold }: { client: Client; products: Product[]; onSold: () => void }) {
  const { width } = useWindowDimensions();
  const wide = width >= 1000;
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>();
  const [ticket, setTicket] = useState<TicketLine[]>([]);
  const [golfer, setGolfer] = useState<GolferAccount | null>(null);
  const [findGolfer, setFindGolfer] = useState(false);
  const [custom, setCustom] = useState(false);
  const [taxBps, setTaxBps] = useState(0);
  const [method, setMethod] = useState<SalePaymentMethod>("card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Sale>();

  useEffect(() => {
    client.posSettings().then((s) => setTaxBps(s.salesTaxBps)).catch(() => undefined);
  }, [client]);

  const categories = useMemo(() => [...new Set(products.map((p) => p.category))], [products]);
  const shown = products.filter(
    (p) => (!category || p.category === category) && (!q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.sku?.toLowerCase() === q.trim().toLowerCase()),
  );

  function add(p: Product) {
    setDone(undefined);
    setTicket((t) => {
      const existing = t.find((l) => l.productId === p.id);
      if (existing) return t.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
      return [...t, { key: p.id, productId: p.id, description: p.name, unitCents: p.priceCents, quantity: 1, taxable: p.taxable }];
    });
  }
  const setQty = (key: string, quantity: number) => setTicket((t) => (quantity < 1 ? t.filter((l) => l.key !== key) : t.map((l) => (l.key === key ? { ...l, quantity } : l))));

  const subtotal = ticket.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const tax = method === "comp" ? 0 : Math.round((ticket.filter((l) => l.taxable).reduce((s, l) => s + l.unitCents * l.quantity, 0) * taxBps) / 10_000);

  const reader = useCardReader();
  const [charging, setCharging] = useState(false);

  async function charge(cardPaymentId?: string) {
    // On a connected reader the card is taken first; the sale is recorded once it goes through.
    if (method === "card" && reader.terminal && !cardPaymentId) return setCharging(true);
    setBusy(true);
    setError(undefined);
    try {
      const sale = await client.sell({
        lines: ticket.map((l) => (l.productId ? { productId: l.productId, quantity: l.quantity } : { description: l.description, unitCents: l.unitCents, quantity: l.quantity, taxable: l.taxable })),
        paymentMethod: method,
        golferId: golfer?.id ?? null,
        ...(cardPaymentId ? { cardPaymentId } : {}),
      });
      setDone(sale);
      setTicket([]);
      setGolfer(null);
      setMethod("card");
      onSold();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sale didn't go through");
    } finally {
      setBusy(false);
    }
  }

  const catalog = (
    <View style={{ flex: 1, minWidth: 0 }}>
      <TextInput accessibilityLabel="Search products or scan a SKU" placeholder="Search products or scan a SKU" value={q} onChangeText={setQ} style={styles.input} />
      <View style={[styles.choices, { marginVertical: 10 }]}>
        <Chip label="All" on={!category} onPress={() => setCategory(undefined)} />
        {categories.map((c) => (
          <Chip key={c} label={c} on={category === c} onPress={() => setCategory(c)} />
        ))}
      </View>
      <View style={styles.tiles}>
        {shown.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityLabel={`Add ${p.name}, ${money(p.priceCents)}${p.trackStock ? `, ${p.stock} in stock` : ""}`}
            onPress={() => add(p)}
            style={({ hovered, focused }: WebPress) => [styles.tile, hovered && { borderColor: colors.primary }, focused && styles.focus]}
          >
            <Text style={styles.tileName} numberOfLines={2}>
              {p.name}
            </Text>
            <View style={styles.rowBetween}>
              <Text style={styles.strong}>{money(p.priceCents)}</Text>
              {p.trackStock && <Text style={[styles.small, p.stock <= 0 ? { color: colors.noShow } : p.low ? { color: colors.warn } : null]}>{p.stock} left</Text>}
            </View>
          </Pressable>
        ))}
        {shown.length === 0 && <Text style={styles.muted}>No products match. Managers add products under Inventory.</Text>}
      </View>
      <Pressable accessibilityRole="button" onPress={() => setCustom(true)} style={{ marginTop: 12 }}>
        <Text style={styles.link}>+ Ring up an item that isn't in the list</Text>
      </Pressable>
    </View>
  );

  const ticketView = (
    <View style={[styles.ticket, wide ? { width: 360 } : { marginTop: 16 }]} role="region" aria-label="Current sale">
      <Text style={styles.label}>Current sale</Text>
      {golfer ? (
        <View style={styles.rowBetween}>
          <Text style={styles.text}>For {golfer.name}</Text>
          <Pressable accessibilityRole="button" onPress={() => setGolfer(null)}>
            <Text style={styles.link}>Remove</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setFindGolfer(true)}>
          <Text style={styles.link}>+ Add golfer account (optional)</Text>
        </Pressable>
      )}
      {done && (
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <Text style={styles.strong}>
            Sale #{done.number} done · {money(done.totalCents)} {methodLabel(done.paymentMethod).toLowerCase()}
          </Text>
        </View>
      )}
      {ticket.length === 0 && !done && <Text style={[styles.muted, { marginTop: 12 }]}>Tap products to add them.</Text>}
      {ticket.map((l) => (
        <View key={l.key} style={styles.ticketLine}>
          <View style={{ flex: 1 }}>
            <Text style={styles.text} numberOfLines={1}>
              {l.description}
            </Text>
            <Text style={styles.small}>
              {money(l.unitCents)} each{l.taxable ? "" : " · no tax"}
            </Text>
          </View>
          <Stepper label={l.description} value={l.quantity} onChange={(n) => setQty(l.key, n)} />
          <Text style={[styles.strong, { width: 72, textAlign: "right" }]}>{money(l.unitCents * l.quantity)}</Text>
        </View>
      ))}
      {ticket.length > 0 && (
        <>
          <View style={styles.totals}>
            <TotalRow label="Subtotal" cents={subtotal} />
            <TotalRow label={`Tax${taxBps ? ` (${(taxBps / 100).toFixed(2)}%)` : ""}`} cents={tax} />
            <TotalRow label="Total" cents={subtotal + tax} strong />
          </View>
          <Text style={styles.label}>Payment</Text>
          <View style={styles.choices}>
            {METHODS.map((m) => (
              <Chip key={m.id} label={m.label} on={method === m.id} onPress={() => setMethod(m.id)} />
            ))}
          </View>
          {method === "card" && reader.needsReader && (
            <Text style={[styles.small, { color: colors.warn, marginTop: 8 }]}>Pick this device's card reader in Settings to send cards to it.</Text>
          )}
          {error && <Text role="alert" style={styles.error}>{error}</Text>}
          <View style={[styles.choices, { marginTop: 14 }]}>
            <Button label={busy ? "Charging…" : `Charge ${money(subtotal + tax)}`} primary disabled={busy} onPress={() => charge()} />
            <Button label="Clear" disabled={busy} onPress={() => setTicket([])} />
          </View>
          {charging && reader.terminal && (
            <CardChargeModal
              client={client}
              terminal={reader.terminal}
              amountCents={subtotal + tax}
              description="Pro shop sale"
              onPaid={(p) => {
                setCharging(false);
                charge(p.id);
              }}
              onClose={() => setCharging(false)}
            />
          )}
        </>
      )}
    </View>
  );

  return (
    <ScrollView contentContainerStyle={[styles.content, wide && { flexDirection: "row", gap: 16, alignItems: "flex-start" }]}>
      {catalog}
      {ticketView}
      {findGolfer && (
        <GolferSearch
          client={client}
          onPick={(g) => {
            setGolfer(g);
            setFindGolfer(false);
          }}
          onClose={() => setFindGolfer(false)}
        />
      )}
      {custom && (
        <CustomItem
          onAdd={(line) => {
            setTicket((t) => [...t, { ...line, key: `c${Date.now()}` }]);
            setCustom(false);
          }}
          onClose={() => setCustom(false)}
        />
      )}
    </ScrollView>
  );
}

function GolferSearch({ client, onPick, onClose }: { client: Client; onPick: (g: GolferAccount) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const { results, error } = useSearch(client, q);
  return (
    <Sheet title="Add golfer account" onClose={onClose}>
      <TextInput autoFocus accessibilityLabel="Golfer's name, phone or email" placeholder="Name, phone or email" value={q} onChangeText={setQ} style={styles.input} />
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {results?.map((g) => (
        <Pressable key={g.id} accessibilityRole="button" onPress={() => onPick(g)} style={({ hovered }: WebPress) => [styles.listRow, hovered && { backgroundColor: colors.bg }]}>
          <Text style={styles.strong}>{g.name}</Text>
          <Text style={styles.small}>
            {g.phone} · {g.email}
          </Text>
        </Pressable>
      ))}
      {results?.length === 0 && <Text style={styles.muted}>No golfer accounts match.</Text>}
      <View style={[styles.choices, { marginTop: 14 }]}>
        <Button label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}

function CustomItem({ onAdd, onClose }: { onAdd: (l: Omit<TicketLine, "key">) => void; onClose: () => void }) {
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [taxable, setTaxable] = useState(true);
  const cents = toCents(price);
  return (
    <Sheet title="Ring up another item" onClose={onClose}>
      <Field label="What is it" value={description} onChangeText={setDescription} placeholder="e.g. Used putter" />
      <Field label="Price ($)" value={price} onChangeText={setPrice} placeholder="0.00" keyboardType="decimal-pad" />
      <View style={[styles.rowBetween, { marginTop: 12 }]}>
        <Text style={styles.text}>Charge sales tax</Text>
        <Switch accessibilityLabel="Charge sales tax" value={taxable} onValueChange={setTaxable} trackColor={{ true: colors.primary, false: colors.border }} />
      </View>
      <View style={[styles.choices, { marginTop: 16 }]}>
        <Button
          label="Add to sale"
          primary
          disabled={!description.trim() || cents === undefined}
          onPress={() => onAdd({ description: description.trim(), unitCents: cents!, quantity: 1, taxable })}
        />
        <Button label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}

function Inventory({ client, products, isManager, onChanged }: { client: Client; products: Product[]; isManager: boolean; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState<Product | "new">();
  const [stockFor, setStockFor] = useState<Product>();
  const shown = products.filter(
    (p) =>
      (showRemoved || p.active) &&
      (!onlyLow || p.low) &&
      (!q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.sku?.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const value = products.filter((p) => p.active && p.trackStock && p.stock > 0).reduce((s, p) => s + p.stock * (p.costCents ?? 0), 0);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.row, { marginBottom: 12 }]}>
        <TextInput accessibilityLabel="Search products" placeholder="Search products" value={q} onChangeText={setQ} style={[styles.input, { flex: 1, minWidth: 200 }]} />
        <Chip label="Low stock only" on={onlyLow} onPress={() => setOnlyLow(!onlyLow)} />
        {isManager && <Chip label="Show removed" on={showRemoved} onPress={() => setShowRemoved(!showRemoved)} />}
        {isManager && <Button label="Add product" primary onPress={() => setEditing("new")} />}
      </View>
      {isManager && value > 0 && <Text style={[styles.muted, { marginBottom: 8, marginTop: 0 }]}>Stock on hand at cost: {money(value)}</Text>}
      <ScrollView horizontal contentContainerStyle={{ minWidth: "100%" }}>
        <View role="table" aria-label="Products" style={[styles.table, { flex: 1, minWidth: 760 }]}>
          <View role="row" style={[styles.tableRow, styles.head]}>
            <Text role="columnheader" style={[styles.headText, { flex: 1 }]}>Product</Text>
            <Text role="columnheader" style={[styles.headText, { width: 110 }]}>Category</Text>
            <Text role="columnheader" style={[styles.headText, styles.num]}>Price</Text>
            <Text role="columnheader" style={[styles.headText, styles.num]}>In stock</Text>
            <Text role="columnheader" style={[styles.headText, styles.num]}>Reorder at</Text>
            <Text role="columnheader" style={[styles.headText, { width: 190 }]} />
          </View>
          {shown.length === 0 && <Text style={[styles.text, { padding: 12 }]}>{products.length ? "No products match." : "No products yet."}</Text>}
          {shown.map((p) => (
            <View key={p.id} role="row" style={[styles.tableRow, !p.active && { opacity: 0.55 }]}>
              <View role="cell" style={{ flex: 1 }}>
                <Text style={styles.strong}>
                  {p.name}
                  {!p.active ? " (removed)" : ""}
                </Text>
                <Text style={styles.small}>
                  {p.sku ?? "No SKU"}
                  {p.taxable ? "" : " · no tax"}
                </Text>
              </View>
              <Text role="cell" style={[styles.text, { width: 110 }]}>{p.category}</Text>
              <Text role="cell" style={[styles.text, styles.num]}>{money(p.priceCents)}</Text>
              <Text role="cell" style={[styles.strong, styles.num, p.trackStock && p.stock <= 0 ? { color: colors.noShow } : p.low ? { color: colors.warn } : null]}>
                {p.trackStock ? `${p.stock}${p.low ? " · low" : ""}` : "Not counted"}
              </Text>
              <Text role="cell" style={[styles.text, styles.num]}>{p.trackStock ? p.reorderLevel : "–"}</Text>
              <View role="cell" style={[styles.choices, { width: 190, justifyContent: "flex-end" }]}>
                {p.trackStock && p.active && <Button label="Stock" onPress={() => setStockFor(p)} />}
                {isManager && <Button label="Edit" onPress={() => setEditing(p)} />}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
      {editing && (
        <ProductEditor
          client={client}
          product={editing === "new" ? undefined : editing}
          categories={[...new Set(products.map((p) => p.category))]}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            onChanged();
          }}
        />
      )}
      {stockFor && (
        <StockSheet
          client={client}
          product={stockFor}
          isManager={isManager}
          onClose={() => setStockFor(undefined)}
          onSaved={() => {
            setStockFor(undefined);
            onChanged();
          }}
        />
      )}
    </ScrollView>
  );
}

function ProductEditor(props: { client: Client; product?: Product; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const { client, product, categories, onClose, onSaved } = props;
  const [name, setName] = useState(product?.name ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [category, setCategory] = useState(product?.category ?? categories[0] ?? "Other");
  const [price, setPrice] = useState(dollars(product?.priceCents));
  const [cost, setCost] = useState(dollars(product?.costCents));
  const [taxable, setTaxable] = useState(product?.taxable ?? true);
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? true);
  const [stock, setStock] = useState(String(product?.stock ?? 0));
  const [reorder, setReorder] = useState(String(product?.reorderLevel ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const priceCents = toCents(price);
  const costCents = cost.trim() ? toCents(cost) : null;
  const valid = name.trim() && priceCents !== undefined && costCents !== undefined && /^\d+$/.test(reorder) && (!trackStock || /^\d+$/.test(stock));

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the product");
      setBusy(false);
    }
  }

  function save() {
    const input: ProductInput = {
      name: name.trim(),
      sku: sku.trim() || null,
      category: category.trim() || "Other",
      priceCents: priceCents!,
      costCents,
      taxable,
      trackStock,
      reorderLevel: Number(reorder),
    };
    return run(async () => {
      if (!product) return client.addProduct({ ...input, stock: trackStock ? Number(stock) : 0 });
      await client.updateProduct(product.id, input);
      // A new number here is a shelf count; sales keep taking it down on their own after this.
      if (trackStock && Number(stock) !== product.stock) await client.changeStock(product.id, { kind: "count", quantity: Number(stock), note: "Set by manager" });
    });
  }

  return (
    <Sheet title={product ? "Edit product" : "Add product"} onClose={onClose}>
      <Field label="Name" value={name} onChangeText={setName} />
      <View style={styles.row}>
        <Field label="SKU or barcode (optional)" value={sku} onChangeText={setSku} autoCapitalize="characters" />
        <Field label="Category" value={category} onChangeText={setCategory} />
      </View>
      {categories.length > 0 && (
        <View style={[styles.choices, { marginTop: 6 }]}>
          {categories.map((c) => (
            <Chip key={c} label={c} on={category === c} onPress={() => setCategory(c)} />
          ))}
        </View>
      )}
      <View style={styles.row}>
        <Field label="Price ($)" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.00" />
        <Field label="Cost ($, optional)" value={cost} onChangeText={setCost} keyboardType="decimal-pad" placeholder="0.00" />
      </View>
      <View style={[styles.rowBetween, { marginTop: 12 }]}>
        <Text style={styles.text}>Charge sales tax</Text>
        <Switch accessibilityLabel="Charge sales tax" value={taxable} onValueChange={setTaxable} trackColor={{ true: colors.primary, false: colors.border }} />
      </View>
      <View style={[styles.rowBetween, { marginTop: 8 }]}>
        <Text style={styles.text}>Keep a stock count</Text>
        <Switch accessibilityLabel="Keep a stock count" value={trackStock} onValueChange={setTrackStock} trackColor={{ true: colors.primary, false: colors.border }} />
      </View>
      {trackStock && (
        <View style={styles.row}>
          <Field label="In stock now" value={stock} onChangeText={setStock} keyboardType="number-pad" />
          <Field label="Reorder when stock reaches" value={reorder} onChangeText={setReorder} keyboardType="number-pad" />
        </View>
      )}
      {trackStock && <Text style={styles.muted}>Each sale at the register takes this down automatically, and a refund puts it back.</Text>}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.choices, { marginTop: 16 }]}>
        <Button label={busy ? "Saving…" : "Save"} primary disabled={busy || !valid} onPress={save} />
        <Button label="Cancel" disabled={busy} onPress={onClose} />
        {product &&
          (product.active ? (
            <Button label="Remove item" danger disabled={busy} onPress={() => run(() => client.updateProduct(product.id, { active: false }))} />
          ) : (
            <Button label="Bring item back" disabled={busy} onPress={() => run(() => client.updateProduct(product.id, { active: true }))} />
          ))}
      </View>
    </Sheet>
  );
}

function StockSheet({ client, product, isManager, onClose, onSaved }: { client: Client; product: Product; isManager: boolean; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<"receive" | "count" | "adjust">("receive");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<StockMovement[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const n = /^-?\d+$/.test(quantity.trim()) ? Number(quantity) : undefined;
  const valid = n !== undefined && (kind === "adjust" ? n !== 0 && note.trim() !== "" : n >= 0 && (kind === "count" || n > 0));

  useEffect(() => {
    client.productHistory(product.id).then(setHistory).catch(() => setHistory([]));
  }, [client, product.id]);

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await client.changeStock(product.id, { kind, quantity: n!, note: note.trim() || null });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the stock");
      setBusy(false);
    }
  }

  const after = n === undefined ? undefined : kind === "count" ? n : product.stock + n;
  return (
    <Sheet title={product.name} onClose={onClose}>
      <Text style={styles.text}>
        {product.stock} in stock · reorder at {product.reorderLevel}
      </Text>
      <View style={[styles.choices, { marginTop: 12 }]}>
        <Chip label="Received a delivery" on={kind === "receive"} onPress={() => setKind("receive")} />
        {isManager && <Chip label="Counted the shelf" on={kind === "count"} onPress={() => setKind("count")} />}
        {isManager && <Chip label="Adjust" on={kind === "adjust"} onPress={() => setKind("adjust")} />}
      </View>
      <Field
        label={kind === "receive" ? "How many came in" : kind === "count" ? "How many are on the shelf" : "Add or take away (e.g. -2)"}
        value={quantity}
        onChangeText={setQuantity}
        keyboardType={kind === "adjust" ? "numbers-and-punctuation" : "number-pad"}
      />
      {(kind === "adjust" || kind === "count") && <Field label={kind === "adjust" ? "Why (required)" : "Note (optional)"} value={note} onChangeText={setNote} placeholder={kind === "adjust" ? "e.g. Damaged in storage" : ""} />}
      {after !== undefined && valid && <Text style={styles.muted}>Stock will be {after}.</Text>}
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      <View style={[styles.choices, { marginTop: 16 }]}>
        <Button label={busy ? "Saving…" : "Save"} primary disabled={busy || !valid} onPress={save} />
        <Button label="Cancel" disabled={busy} onPress={onClose} />
      </View>
      <Text style={[styles.label, { marginTop: 20 }]}>Stock history</Text>
      {!history ? (
        <ActivityIndicator color={colors.primary} />
      ) : history.length === 0 ? (
        <Text style={styles.muted}>No changes yet.</Text>
      ) : (
        history.slice(0, 20).map((m) => (
          <View key={m.id} style={styles.listRow}>
            <View style={styles.rowBetween}>
              <Text style={styles.text}>
                {REASON[m.reason]}
                {m.saleNumber ? ` (sale #${m.saleNumber})` : ""}: {m.change > 0 ? `+${m.change}` : m.change}
              </Text>
              <Text style={styles.small}>now {m.stockAfter}</Text>
            </View>
            <Text style={styles.small}>
              {new Date(m.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {m.staff ? ` · ${m.staff}` : ""}
              {m.note ? ` · ${m.note}` : ""}
            </Text>
          </View>
        ))
      )}
    </Sheet>
  );
}

function SalesView({ client, isManager, timeZone, onRefunded }: { client: Client; isManager: boolean; timeZone: string; onRefunded: () => void }) {
  const today = todayIn(timeZone);
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<SalesDay>();
  const [open, setOpen] = useState<string>();
  const [refunding, setRefunding] = useState<string>();
  const [taxBps, setTaxBps] = useState<number>();
  const [taxText, setTaxText] = useState("");
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    client.sales(date).then(setDay).catch((e) => setError(e.message));
  }, [client, date]);
  useEffect(() => {
    setDay(undefined);
    load();
  }, [load]);
  useEffect(() => {
    client
      .posSettings()
      .then((s) => {
        setTaxBps(s.salesTaxBps);
        setTaxText((s.salesTaxBps / 100).toFixed(2));
      })
      .catch(() => undefined);
  }, [client]);

  async function refund(id: string) {
    setError(undefined);
    try {
      await client.refundSale(id);
      setRefunding(undefined);
      load();
      onRefunded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't refund the sale");
    }
  }

  async function saveTax() {
    const pct = Number(taxText);
    if (!(pct >= 0 && pct <= 20)) return setError("Enter a tax rate between 0 and 20%");
    try {
      const s = await client.savePosSettings({ salesTaxBps: Math.round(pct * 100) });
      setTaxBps(s.salesTaxBps);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the tax rate");
    }
  }

  const s = day?.summary;
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.row, { marginBottom: 12 }]}>
        <Button label="‹" label2="Previous day" onPress={() => setDate(addDays(date, -1))} />
        <Text role="heading" aria-level={2} style={styles.dayTitle}>
          {date === today ? "Today" : dayParts(date).long}
        </Text>
        <Button label="›" label2="Next day" disabled={date >= today} onPress={() => setDate(addDays(date, 1))} />
        {date !== today && <Button label="Today" onPress={() => setDate(today)} />}
      </View>
      {error && <Text role="alert" style={styles.error}>{error}</Text>}
      {!day || !s ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <View style={styles.stats}>
            <Stat label="Sales" value={String(s.count)} />
            <Stat label="Before tax" value={money(s.subtotalCents)} />
            <Stat label="Tax" value={money(s.taxCents)} />
            <Stat label="Total taken" value={money(s.totalCents)} />
            {s.refundedCents > 0 && <Stat label="Refunded" value={money(s.refundedCents)} warn />}
          </View>
          {s.count > 0 && (
            <View style={[styles.row, { alignItems: "flex-start", marginTop: 12 }]}>
              <Breakdown title="By payment" rows={Object.entries(s.byMethod).map(([k, v]) => [methodLabel(k), v ?? 0])} />
              <Breakdown title="By category (before tax)" rows={Object.entries(s.byCategory).sort((a, b) => b[1] - a[1])} />
            </View>
          )}
          <Text style={[styles.label, { marginTop: 16 }]}>Sales</Text>
          <View style={styles.table}>
            {day.sales.length === 0 && <Text style={[styles.text, { padding: 12 }]}>No sales on this day.</Text>}
            {day.sales.map((sale) => (
              <View key={sale.id}>
                <Pressable
                  aria-expanded={open === sale.id}
                  onPress={() => setOpen(open === sale.id ? undefined : sale.id)}
                  style={({ hovered, focused }: WebPress) => [styles.tableRow, hovered && { backgroundColor: colors.bg }, focused && styles.focus]}
                >
                  <Text style={[styles.text, { width: 70 }]}>#{sale.number}</Text>
                  <Text style={[styles.text, { width: 80 }]}>{time(sale.at)}</Text>
                  <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>
                    {sale.lines.map((l) => (l.quantity > 1 ? `${l.quantity} × ${l.description}` : l.description)).join(", ")}
                  </Text>
                  <Text style={[styles.small, { width: 120 }]} numberOfLines={1}>
                    {sale.golfer?.name ?? ""}
                  </Text>
                  <Text style={[styles.text, { width: 80 }]}>{methodLabel(sale.paymentMethod)}</Text>
                  <Text style={[styles.strong, styles.num, sale.status === "refunded" && { color: colors.noShow, textDecorationLine: "line-through" }]}>{money(sale.totalCents)}</Text>
                </Pressable>
                {open === sale.id && (
                  <View style={[styles.detail]}>
                    {sale.lines.map((l, i) => (
                      <View key={i} style={styles.rowBetween}>
                        <Text style={styles.text}>
                          {l.quantity} × {l.description}
                        </Text>
                        <Text style={styles.text}>{money(l.totalCents)}</Text>
                      </View>
                    ))}
                    <View style={styles.rowBetween}>
                      <Text style={styles.small}>Tax</Text>
                      <Text style={styles.small}>{money(sale.taxCents)}</Text>
                    </View>
                    <Text style={styles.small}>
                      Rung up by {sale.staff ?? "a shared device"}
                      {sale.status === "refunded" ? " · Refunded" : ""}
                    </Text>
                    {isManager && sale.status === "completed" && (
                      <View style={[styles.choices, { marginTop: 8 }]}>
                        {refunding === sale.id ? (
                          <>
                            <Text style={styles.text}>Refund {money(sale.totalCents)} and put the items back in stock?</Text>
                            <Button label="Refund" danger onPress={() => refund(sale.id)} />
                            <Button label="Keep sale" onPress={() => setRefunding(undefined)} />
                          </>
                        ) : (
                          <Button label="Refund sale" onPress={() => setRefunding(sale.id)} />
                        )}
                      </View>
                    )}
                  </View>
                )}
              </View>
            ))}
          </View>
          {isManager && taxBps !== undefined && (
            <View style={[styles.card, { marginTop: 20 }]}>
              <Text style={styles.strong}>Sales tax rate</Text>
              <Text style={styles.muted}>Charged on taxable pro shop items. Check the rate for the course's address with your accountant.</Text>
              <View style={[styles.row, { marginTop: 8 }]}>
                <TextInput accessibilityLabel="Sales tax percent" value={taxText} onChangeText={setTaxText} keyboardType="decimal-pad" style={[styles.input, { width: 100 }]} />
                <Text style={styles.text}>%</Text>
                <Button label="Save rate" disabled={Math.round(Number(taxText) * 100) === taxBps} onPress={saveTax} />
              </View>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <View style={[styles.card, { flex: 1, minWidth: 240 }]}>
      <Text style={styles.label}>{title}</Text>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.rowBetween}>
          <Text style={styles.text}>{k}</Text>
          <Text style={styles.text}>{money(v)}</Text>
        </View>
      ))}
    </View>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, warn && { color: colors.noShow }]}>{value}</Text>
      <Text style={styles.small}>{label}</Text>
    </View>
  );
}

function TotalRow({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <View style={styles.rowBetween}>
      <Text style={strong ? styles.totalText : styles.text}>{label}</Text>
      <Text style={strong ? styles.totalText : styles.text}>{money(cents)}</Text>
    </View>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <View style={styles.stepper}>
      <Pressable accessibilityRole="button" accessibilityLabel={`One fewer ${label}`} onPress={() => onChange(value - 1)} style={styles.stepButton}>
        <Text style={styles.stepText}>−</Text>
      </Pressable>
      <Text style={[styles.text, { minWidth: 24, textAlign: "center" }]} accessibilityLabel={`${value} ${label}`}>
        {value}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`One more ${label}`} onPress={() => onChange(value + 1)} style={styles.stepButton}>
        <Text style={styles.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View role="dialog" aria-label={title} style={styles.sheet}>
          <ScrollView>
            <Text role="heading" aria-level={2} style={styles.sheetTitle}>
              {title}
            </Text>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Field(props: { label: string } & React.ComponentProps<typeof TextInput>) {
  const { label, ...input } = props;
  return (
    <View style={{ marginTop: 10, flex: 1, minWidth: 160 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} autoCorrect={false} style={styles.input} {...input} />
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, on && styles.buttonOn, hovered && !on && { backgroundColor: colors.bg }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, on && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

function Button(props: { label: string; label2?: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  const { label, label2, onPress, primary, danger, disabled } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label2 ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: WebPress) => [styles.button, primary && styles.buttonOn, hovered && !primary && { backgroundColor: colors.bg }, disabled && { opacity: 0.5 }, focused && styles.focus]}
    >
      <Text style={[styles.buttonText, primary && { color: "#fff" }, danger && { color: colors.noShow }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderColor: "transparent", marginBottom: -1 },
  tabOn: { borderColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: "600", color: colors.muted },
  tabTextOn: { color: colors.text },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: 168, minHeight: 72, borderWidth: 1, borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card, padding: 8, justifyContent: "space-between" },
  tileName: { fontSize: 13, fontWeight: "600", color: colors.text },
  ticket: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card, padding: 12 },
  ticketLine: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  totals: { gap: 4, marginTop: 10 },
  totalText: { fontSize: 15, fontWeight: "700", color: colors.text },
  stepper: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius },
  stepButton: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  stepText: { fontSize: 16, color: colors.primary, fontWeight: "700" },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, backgroundColor: colors.card },
  tableRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  head: { backgroundColor: colors.bg },
  headText: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  num: { width: 90, textAlign: "right" },
  detail: { paddingHorizontal: 24, paddingVertical: 10, gap: 4, backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, padding: 12 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, paddingVertical: 8, minWidth: 130 },
  statValue: { fontSize: 18, fontWeight: "700", color: colors.text },
  dayTitle: { fontSize: 15, fontWeight: "700", color: colors.text, marginHorizontal: 4 },
  listRow: { paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border },
  label: { fontSize: 11, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 12, marginBottom: 6 },
  text: { color: colors.text, fontSize: 13, lineHeight: 19 },
  strong: { color: colors.text, fontSize: 13, fontWeight: "700" },
  small: { color: colors.muted, fontSize: 11 },
  muted: { color: colors.muted, fontSize: 12, marginTop: 8 },
  link: { color: colors.primary, fontSize: 13, fontWeight: "600", textDecorationLine: "underline", marginTop: 6 },
  notice: { backgroundColor: colors.primaryLight, borderRadius: radius, padding: 10, marginTop: 10 },
  error: { color: colors.noShow, marginVertical: 8 },
  button: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 12, minHeight: 32, justifyContent: "center", backgroundColor: colors.card },
  buttonOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  buttonText: { fontSize: 13, fontWeight: "600", color: colors.text },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: colors.text, backgroundColor: "#fff" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", alignItems: "center", padding: 16 },
  sheet: { backgroundColor: colors.card, borderRadius: radius, padding: 18, width: "100%", maxWidth: 560, maxHeight: "90%" },
  sheetTitle: { fontSize: 16, fontWeight: "700", color: colors.text, marginBottom: 4 },
  focus: { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: "solid" } as object,
});
