import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { useCardPayment } from "./payments.ts";
import { getSale, insertSale, type SalePaymentMethod, type Station, type TabLine } from "./pos.ts";

// Food and bar. A tab collects a golfer's or a table's orders: items for the kitchen or bar show
// up on that prep screen as soon as they're added, and the tab is paid at the end like any
// register sale, so tax, stock, loyalty points and the cash drawer all work the same way.

export type TabLocation = "grill" | "bar" | "turn" | "cart";
export type ItemStatus = "sent" | "ready" | "served" | "void";

export type TabItemInput =
  | { productId: string; quantity: number; note?: string | null }
  | { description: string; unitCents: number; quantity: number; taxable?: boolean; station?: Station | null; note?: string | null };

const toItem = (r: any) => ({
  id: r.id,
  productId: r.product_id,
  description: r.description,
  category: r.category,
  quantity: r.quantity,
  unitCents: r.unit_cents,
  totalCents: r.unit_cents * r.quantity,
  taxable: r.taxable,
  station: r.station as Station | null,
  note: r.note,
  status: r.status as ItemStatus,
  addedBy: r.added_by_name ?? null,
  addedAt: r.added_at.toISOString(),
});

async function tabRow(db: DbClient, course: Course, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM tabs WHERE id = $1 AND course_id = $2${lock ? " FOR UPDATE" : ""}`, [id, course.id]);
  if (!rows[0]) throw notFound("Tab");
  return rows[0];
}

async function openOnly(db: DbClient, course: Course, id: string) {
  const tab = await tabRow(db, course, id, true);
  if (tab.status !== "open") throw conflict("tab_closed", tab.status === "void" ? "This tab was voided" : "This tab has been paid");
  return tab;
}

export async function getTab(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(
    `SELECT t.*, c.name AS golfer_name, o.name AS opened_by_name, tt.starts_at AS tee_time
       FROM tabs t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN staff_users o ON o.id = t.opened_by
       LEFT JOIN bookings b ON b.id = t.booking_id LEFT JOIN tee_times tt ON tt.id = b.tee_time_id
      WHERE t.id = $1 AND t.course_id = $2`,
    [id, course.id],
  );
  if (!rows[0]) throw notFound("Tab");
  const { rows: items } = await db.query(
    `SELECT i.*, u.name AS added_by_name FROM tab_items i LEFT JOIN staff_users u ON u.id = i.added_by WHERE i.tab_id = $1 ORDER BY i.added_at, i.description`,
    [id],
  );
  return toTab(rows[0], items, await taxRate(db, course));
}

async function taxRate(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT sales_tax_bps FROM courses WHERE id = $1", [course.id]);
  return rows[0].sales_tax_bps as number;
}

function toTab(r: any, items: any[], bps: number) {
  const list = items.map(toItem);
  const kept = list.filter((i) => i.status !== "void");
  const subtotal = kept.reduce((s, i) => s + i.totalCents, 0);
  const taxable = kept.filter((i) => i.taxable).reduce((s, i) => s + i.totalCents, 0);
  return {
    id: r.id,
    name: r.name,
    location: r.location as TabLocation,
    status: r.status as "open" | "closed" | "void",
    golfer: r.customer_id ? { id: r.customer_id, name: r.golfer_name } : null,
    bookingId: r.booking_id,
    teeTime: r.tee_time ? r.tee_time.toISOString() : null,
    openedBy: r.opened_by_name ?? null,
    openedAt: r.opened_at.toISOString(),
    closedAt: r.closed_at?.toISOString() ?? null,
    saleId: r.sale_id,
    voidReason: r.void_reason,
    items: list,
    subtotalCents: subtotal,
    // What the sale will charge when the tab is paid.
    taxCents: Math.round((taxable * bps) / 10_000),
    waiting: kept.filter((i) => i.status === "sent" || i.status === "ready").length,
  };
}

/** Open tabs (or a day's closed ones), newest first, with what's on each. */
export async function listTabs(db: DbClient, course: Course, opts: { status?: "open" | "closed" } = {}) {
  const status = opts.status ?? "open";
  const { rows } = await db.query(
    `SELECT t.*, c.name AS golfer_name, o.name AS opened_by_name, tt.starts_at AS tee_time
       FROM tabs t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN staff_users o ON o.id = t.opened_by
       LEFT JOIN bookings b ON b.id = t.booking_id LEFT JOIN tee_times tt ON tt.id = b.tee_time_id
      WHERE t.course_id = $1 AND t.status = $2 AND ($2 = 'open' OR t.closed_at > now() - interval '1 day')
      ORDER BY t.opened_at DESC LIMIT 200`,
    [course.id, status],
  );
  if (!rows.length) return [];
  const { rows: items } = await db.query(
    `SELECT i.*, u.name AS added_by_name FROM tab_items i LEFT JOIN staff_users u ON u.id = i.added_by WHERE i.tab_id = ANY($1) ORDER BY i.added_at`,
    [rows.map((r) => r.id)],
  );
  const bps = await taxRate(db, course);
  return rows.map((r) => toTab(r, items.filter((i) => i.tab_id === r.id), bps));
}

export async function openTab(
  db: Db,
  course: Course,
  staffId: string | undefined,
  input: { name?: string | null; location?: TabLocation; golferId?: string | null; bookingId?: string | null },
) {
  let name = input.name?.trim() || "";
  let golferId = input.golferId ?? null;
  if (input.bookingId) {
    const { rows } = await db.query(
      `SELECT c.name AS customer_name, b.customer_id, b.status, c.account_created_at FROM bookings b JOIN customers c ON c.id = b.customer_id
        WHERE b.id = $1 AND b.course_id = $2`,
      [input.bookingId, course.id],
    );
    if (!rows[0] || rows[0].status === "cancelled") throw notFound("Booking");
    name ||= rows[0].customer_name;
    if (!golferId && rows[0].account_created_at) golferId = rows[0].customer_id;
    const { rows: open } = await db.query("SELECT id FROM tabs WHERE booking_id = $1 AND status = 'open'", [input.bookingId]);
    if (open[0]) throw conflict("tab_open", "This group already has an open tab");
  }
  if (golferId) {
    const { rows } = await db.query("SELECT name FROM customers WHERE id = $1 AND organization_id = $2 AND account_created_at IS NOT NULL", [golferId, course.organizationId]);
    if (!rows[0]) throw notFound("Golfer account");
    name ||= rows[0].name;
  }
  if (!name) throw badRequest("name_required", "Name the tab, e.g. the golfer or the table");
  const { rows } = await db.query(
    "INSERT INTO tabs (course_id, name, location, customer_id, booking_id, opened_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [course.id, name, input.location ?? "grill", golferId, input.bookingId ?? null, staffId ?? null],
  );
  return getTab(db, course, rows[0].id);
}

/** Adds items to an open tab. Anything made in the kitchen or at the bar goes to its screen right away. */
export async function addTabItems(db: Db, course: Course, staffId: string | undefined, id: string, lines: TabItemInput[]) {
  if (!lines.length) throw badRequest("empty_order", "Add something first");
  await withTransaction(db, async (client) => {
    await openOnly(client, course, id);
    for (const l of lines) {
      let item: { productId: string | null; description: string; category: string; unitCents: number; taxable: boolean; foodBev: boolean; station: Station | null };
      if ("productId" in l) {
        const { rows } = await client.query("SELECT * FROM products WHERE id = $1 AND course_id = $2", [l.productId, course.id]);
        const p = rows[0];
        if (!p) throw notFound("Product");
        if (!p.active) throw badRequest("product_inactive", `${p.name} is no longer sold`);
        item = { productId: p.id, description: p.name, category: p.category, unitCents: p.price_cents, taxable: p.taxable, foodBev: p.food_bev, station: p.station };
      } else {
        if (!l.description.trim()) throw badRequest("description_required", "Name the item");
        const station = l.station ?? null;
        item = { productId: null, description: l.description.trim(), category: station ? "Food & drink" : "Other", unitCents: l.unitCents, taxable: l.taxable ?? true, foodBev: !!station, station };
      }
      await client.query(
        `INSERT INTO tab_items (tab_id, product_id, description, category, quantity, unit_cents, taxable, food_bev, station, note, status, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, item.productId, item.description, item.category, l.quantity, item.unitCents, item.taxable, item.foodBev, item.station, l.note?.trim() || null, item.station ? "sent" : "served", staffId ?? null],
      );
    }
  });
  return getTab(db, course, id);
}

/**
 * Takes an item off a tab. Anyone can take off something the kitchen hasn't made yet;
 * once it's made (ready or served), only a manager can, since the food was used.
 */
export async function voidTabItem(db: Db, course: Course, id: string, itemId: string, isManager: boolean) {
  await withTransaction(db, async (client) => {
    await openOnly(client, course, id);
    const { rows } = await client.query("SELECT status, station FROM tab_items WHERE id = $1 AND tab_id = $2 FOR UPDATE", [itemId, id]);
    if (!rows[0]) throw notFound("Item");
    if (rows[0].status === "void") return;
    if (rows[0].station && rows[0].status !== "sent" && !isManager) throw conflict("already_made", "It's already been made. Ask a manager to take it off");
    await client.query("UPDATE tab_items SET status = 'void' WHERE id = $1", [itemId]);
  });
  return getTab(db, course, id);
}

export async function renameTab(db: DbClient, course: Course, id: string, name: string) {
  await openOnly(db, course, id);
  if (!name.trim()) throw badRequest("name_required", "Name the tab");
  await db.query("UPDATE tabs SET name = $2 WHERE id = $1", [id, name.trim()]);
  return getTab(db, course, id);
}

/** Pays a tab: its items become a register sale (tax, stock and points included) and the tab closes. */
export async function closeTab(
  db: Db,
  course: Course,
  staffId: string | undefined,
  id: string,
  input: { paymentMethod: SalePaymentMethod; cardPaymentId?: string | null; giftCardCode?: string | null },
) {
  const saleId = await withTransaction(db, async (client) => {
    const tab = await openOnly(client, course, id);
    const { rows: items } = await client.query("SELECT * FROM tab_items WHERE tab_id = $1 AND status <> 'void' ORDER BY added_at", [id]);
    if (!items.length) throw badRequest("empty_tab", "There's nothing on this tab. Void it instead");
    const lines: TabLine[] = items.map((i) =>
      i.product_id
        ? { productId: i.product_id, quantity: i.quantity, unitCents: i.unit_cents }
        : { description: i.description, unitCents: i.unit_cents, quantity: i.quantity, taxable: i.taxable, category: i.category, foodBev: i.food_bev, station: i.station },
    );
    const saleId = await insertSale(client, course, staffId, { lines, paymentMethod: input.paymentMethod, golferId: tab.customer_id, giftCardCode: input.giftCardCode });
    if (input.cardPaymentId) {
      if (input.paymentMethod !== "card") throw badRequest("not_card", "A card payment can only pay a tab closed as card");
      const { rows } = await client.query("SELECT total_cents FROM sales WHERE id = $1", [saleId]);
      await useCardPayment(client, course, input.cardPaymentId, rows[0].total_cents, { saleId });
      await client.query("UPDATE sales SET card_payment_id = $2 WHERE id = $1", [saleId, input.cardPaymentId]);
    }
    // Anything still on the prep screen is done with once the tab's paid.
    await client.query("UPDATE tab_items SET status = 'served', served_at = now() WHERE tab_id = $1 AND status IN ('sent', 'ready')", [id]);
    await client.query("UPDATE tabs SET status = 'closed', sale_id = $2, closed_by = $3, closed_at = now() WHERE id = $1", [id, saleId, staffId ?? null]);
    return saleId;
  });
  return { tab: await getTab(db, course, id), sale: await getSale(db, course, saleId) };
}

/** Voids a whole tab, e.g. one opened by mistake or a walkout. Managers only once something was made. */
export async function voidTab(db: Db, course: Course, staffId: string | undefined, id: string, reason: string, isManager: boolean) {
  await withTransaction(db, async (client) => {
    await openOnly(client, course, id);
    const { rows } = await client.query("SELECT 1 FROM tab_items WHERE tab_id = $1 AND status <> 'void' LIMIT 1", [id]);
    if (rows[0] && !isManager) throw conflict("tab_has_items", "Only a manager can void a tab with items on it");
    if (!reason.trim()) throw badRequest("reason_required", "Say why it's being voided");
    await client.query("UPDATE tab_items SET status = 'void' WHERE tab_id = $1", [id]);
    await client.query("UPDATE tabs SET status = 'void', void_reason = $2, closed_by = $3, closed_at = now() WHERE id = $1", [id, reason.trim(), staffId ?? null]);
  });
  return getTab(db, course, id);
}

/**
 * The kitchen or bar screen: every item that's been ordered and not yet handed over, grouped
 * into tickets (one per tab and order time), oldest first.
 */
export async function prepTickets(db: DbClient, course: Course, station: Station) {
  const { rows } = await db.query(
    `SELECT i.*, t.name AS tab_name, t.location, u.name AS added_by_name
       FROM tab_items i JOIN tabs t ON t.id = i.tab_id LEFT JOIN staff_users u ON u.id = i.added_by
      WHERE t.course_id = $1 AND i.station = $2 AND i.status IN ('sent', 'ready') AND t.status = 'open'
      ORDER BY i.added_at, i.description`,
    [course.id, station],
  );
  const tickets = new Map<string, { key: string; tabId: string; tabName: string; location: TabLocation; orderedAt: string; by: string | null; items: ReturnType<typeof toItem>[] }>();
  for (const r of rows) {
    // Items added to the same tab within a minute of each other were one order.
    const minute = Math.floor(r.added_at.getTime() / 60_000);
    const key = `${r.tab_id}:${minute}`;
    if (!tickets.has(key)) tickets.set(key, { key, tabId: r.tab_id, tabName: r.tab_name, location: r.location, orderedAt: r.added_at.toISOString(), by: r.added_by_name ?? null, items: [] });
    tickets.get(key)!.items.push(toItem(r));
  }
  return [...tickets.values()];
}

/** Moves items along on the prep screen: made (ready), handed over (served), or back to sent. */
export async function setItemStatus(db: DbClient, course: Course, itemIds: string[], status: "sent" | "ready" | "served") {
  const { rowCount } = await db.query(
    `UPDATE tab_items i SET status = $3,
            ready_at = CASE WHEN $3 = 'ready' THEN now() WHEN $3 = 'sent' THEN NULL ELSE ready_at END,
            served_at = CASE WHEN $3 = 'served' THEN now() ELSE NULL END
       FROM tabs t WHERE t.id = i.tab_id AND t.course_id = $1 AND i.id = ANY($2) AND i.status IN ('sent', 'ready', 'served') AND i.station IS NOT NULL AND t.status = 'open'`,
    [course.id, itemIds, status],
  );
  if (!rowCount) throw notFound("Item");
  return { updated: rowCount };
}
