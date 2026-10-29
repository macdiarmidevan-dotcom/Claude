import { DateTime } from "luxon";
import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { useCardPayment } from "./payments.ts";
import { earnPoints, reverseSalePoints } from "./loyalty.ts";

// The pro shop: products and their stock, and the register that sells them. Every change to a
// product's stock is recorded with who made it and why, so a count that's off can be traced.

export type SalePaymentMethod = "card" | "cash" | "gift_card" | "comp";

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  category: string;
  priceCents: number;
  costCents: number | null;
  taxable: boolean;
  trackStock: boolean;
  stock: number;
  reorderLevel: number;
  /** Stock is at or below the reorder level. */
  low: boolean;
  active: boolean;
}

export interface ProductInput {
  name: string;
  sku?: string | null;
  category?: string;
  priceCents: number;
  costCents?: number | null;
  taxable?: boolean;
  trackStock?: boolean;
  reorderLevel?: number;
  /** Starting stock for a new product. */
  stock?: number;
}

export type SaleLineInput =
  | { productId: string; quantity: number }
  | { description: string; unitCents: number; quantity: number; taxable?: boolean; category?: string };

const toProduct = (r: any): Product => ({
  id: r.id,
  name: r.name,
  sku: r.sku,
  category: r.category,
  priceCents: r.price_cents,
  costCents: r.cost_cents,
  taxable: r.taxable,
  trackStock: r.track_stock,
  stock: r.stock,
  reorderLevel: r.reorder_level,
  low: r.track_stock && r.active && r.stock <= r.reorder_level,
  active: r.active,
});

const skuTaken = (err: unknown) => {
  if ((err as { code?: string }).code === "23505") throw conflict("sku_taken", "Another product already uses that SKU");
  throw err;
};

export async function listProducts(db: DbClient, course: Course, opts: { q?: string; includeInactive?: boolean } = {}) {
  const q = opts.q?.trim().toLowerCase() ?? "";
  const { rows } = await db.query(
    `SELECT * FROM products WHERE course_id = $1 AND ($2 OR active)
        AND ($3 = '' OR lower(name) LIKE '%' || $3 || '%' OR lower(sku) = $3)
      ORDER BY lower(category), lower(name)`,
    [course.id, opts.includeInactive ?? false, q.replace(/[\\%_]/g, "\\$&")],
  );
  return rows.map(toProduct);
}

async function productRow(db: DbClient, course: Course, id: string, lock = false) {
  const { rows } = await db.query(`SELECT * FROM products WHERE id = $1 AND course_id = $2${lock ? " FOR UPDATE" : ""}`, [id, course.id]);
  if (!rows[0]) throw notFound("Product");
  return rows[0];
}

export async function createProduct(db: Db, course: Course, staffId: string | undefined, input: ProductInput) {
  return withTransaction(db, async (client) => {
    const stock = input.trackStock === false ? 0 : (input.stock ?? 0);
    const { rows } = await client
      .query(
        `INSERT INTO products (course_id, name, sku, category, price_cents, cost_cents, taxable, track_stock, stock, reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          course.id,
          input.name.trim(),
          input.sku?.trim() || null,
          input.category?.trim() || "Other",
          input.priceCents,
          input.costCents ?? null,
          input.taxable ?? true,
          input.trackStock ?? true,
          stock,
          input.reorderLevel ?? 0,
        ],
      )
      .catch(skuTaken);
    if (stock) await recordMovement(client, rows[0].id, stock, stock, "receive", null, "Starting stock", staffId);
    return toProduct(rows[0]);
  });
}

export async function updateProduct(db: DbClient, course: Course, id: string, patch: Partial<Omit<ProductInput, "stock">> & { active?: boolean }) {
  await productRow(db, course, id);
  const { rows } = await db
    .query(
      `UPDATE products SET
         name = COALESCE($2, name), sku = CASE WHEN $3 THEN $4 ELSE sku END, category = COALESCE($5, category),
         price_cents = COALESCE($6, price_cents), cost_cents = CASE WHEN $7 THEN $8 ELSE cost_cents END,
         taxable = COALESCE($9, taxable), track_stock = COALESCE($10, track_stock),
         reorder_level = COALESCE($11, reorder_level), active = COALESCE($12, active)
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.name?.trim() ?? null,
        patch.sku !== undefined,
        patch.sku?.trim() || null,
        patch.category?.trim() || null,
        patch.priceCents ?? null,
        patch.costCents !== undefined,
        patch.costCents ?? null,
        patch.taxable ?? null,
        patch.trackStock ?? null,
        patch.reorderLevel ?? null,
        patch.active ?? null,
      ],
    )
    .catch(skuTaken);
  return toProduct(rows[0]);
}

async function recordMovement(
  db: DbClient,
  productId: string,
  change: number,
  stockAfter: number,
  reason: string,
  saleId: string | null,
  note: string | null,
  staffId: string | undefined,
) {
  await db.query(
    `INSERT INTO stock_movements (product_id, change, stock_after, reason, sale_id, note, staff_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [productId, change, stockAfter, reason, saleId, note, staffId ?? null],
  );
}

/**
 * Changes a product's stock: a delivery received (adds), a shelf count (sets the number
 * counted), or an adjustment such as damage or theft (adds or takes away, with a note).
 */
export async function changeStock(
  db: Db,
  course: Course,
  staffId: string | undefined,
  id: string,
  input: { kind: "receive" | "count" | "adjust"; quantity: number; note?: string | null },
) {
  if (input.kind === "adjust" && !input.note?.trim()) throw badRequest("note_required", "Say why the stock is being adjusted");
  if (input.kind !== "adjust" && input.quantity < 0) throw badRequest("invalid_quantity", "Enter zero or more");
  return withTransaction(db, async (client) => {
    const p = await productRow(client, course, id, true);
    if (!p.track_stock) throw badRequest("not_tracked", "This product doesn't keep a stock count");
    const after = input.kind === "count" ? input.quantity : p.stock + input.quantity;
    const change = after - p.stock;
    const { rows } = await client.query("UPDATE products SET stock = $2 WHERE id = $1 RETURNING *", [id, after]);
    await recordMovement(client, id, change, after, input.kind, null, input.note?.trim() || null, staffId);
    return toProduct(rows[0]);
  });
}

export async function productHistory(db: DbClient, course: Course, id: string) {
  await productRow(db, course, id);
  const { rows } = await db.query(
    `SELECT m.*, u.name AS staff_name, s.number AS sale_number FROM stock_movements m
       LEFT JOIN staff_users u ON u.id = m.staff_user_id LEFT JOIN sales s ON s.id = m.sale_id
      WHERE m.product_id = $1 ORDER BY m.created_at DESC LIMIT 100`,
    [id],
  );
  return rows.map((r) => ({
    id: r.id,
    change: r.change,
    stockAfter: r.stock_after,
    reason: r.reason,
    saleNumber: r.sale_number,
    note: r.note,
    staff: r.staff_name,
    at: r.created_at.toISOString(),
  }));
}

/** Tax on the taxable part of a sale, rounded to the cent. */
export const taxOn = (taxableCents: number, bps: number) => Math.round((taxableCents * bps) / 10_000);

/**
 * Rings up a sale. Stocked products come off the shelf count in the same transaction, and
 * each gets a stock movement pointing back at the sale.
 */
export async function createSale(
  db: Db,
  course: Course,
  staffId: string | undefined,
  input: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod; golferId?: string | null; cardPaymentId?: string | null },
) {
  const id = await withTransaction(db, async (client) => {
    const saleId = await insertSale(client, course, staffId, input);
    // Paid on a connected card reader: the card must match the sale's total, tax included.
    if (input.cardPaymentId) {
      if (input.paymentMethod !== "card") throw badRequest("not_card", "A card payment can only pay a sale rung up as card");
      const { rows } = await client.query("SELECT total_cents FROM sales WHERE id = $1", [saleId]);
      await useCardPayment(client, course, input.cardPaymentId, rows[0].total_cents, { saleId });
      await client.query("UPDATE sales SET card_payment_id = $2 WHERE id = $1", [saleId, input.cardPaymentId]);
    }
    return saleId;
  });
  return getSale(db, course, id);
}

/** Records a sale inside the caller's transaction, e.g. items bought at tee time check-in. */
export async function insertSale(
  client: DbClient,
  course: Course,
  staffId: string | undefined,
  input: { lines: SaleLineInput[]; paymentMethod: SalePaymentMethod; golferId?: string | null },
): Promise<string> {
  if (!input.lines.length) throw badRequest("empty_sale", "Add something to the sale first");
  if (input.golferId) {
    const { rows } = await client.query("SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2 AND account_created_at IS NOT NULL", [
      input.golferId,
      course.organizationId,
    ]);
    if (!rows[0]) throw notFound("Golfer account");
  }
  // Lock products in a fixed order so two registers selling the same items can't deadlock.
  const productIds = [...new Set(input.lines.flatMap((l) => ("productId" in l ? [l.productId] : [])))].sort();
  const products = new Map<string, any>();
  for (const pid of productIds) {
    const p = await productRow(client, course, pid, true);
    if (!p.active) throw badRequest("product_inactive", `${p.name} is no longer sold`);
    products.set(pid, p);
  }
  const lines = input.lines.map((l) => {
    if ("productId" in l) {
      const p = products.get(l.productId);
      return { productId: p.id, description: p.name, category: p.category, quantity: l.quantity, unitCents: p.price_cents, taxable: p.taxable };
    }
    if (!l.description.trim()) throw badRequest("description_required", "Name the item");
    return { productId: null, description: l.description.trim(), category: l.category ?? "Other", quantity: l.quantity, unitCents: l.unitCents, taxable: l.taxable ?? true };
  });
  const { rows: numbers } = await client.query(
    "UPDATE courses SET next_sale_number = next_sale_number + 1 WHERE id = $1 RETURNING next_sale_number - 1 AS number, sales_tax_bps",
    [course.id],
  );
  const subtotal = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  // Comps are given away, so there's nothing to tax.
  const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const tax = input.paymentMethod === "comp" ? 0 : taxOn(taxable, numbers[0].sales_tax_bps);

  const { rows } = await client.query(
    `INSERT INTO sales (course_id, number, staff_user_id, customer_id, subtotal_cents, tax_cents, total_cents, payment_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [course.id, numbers[0].number, staffId ?? null, input.golferId ?? null, subtotal, tax, subtotal + tax, input.paymentMethod],
  );
  const saleId = rows[0].id as string;
  for (const l of lines) {
    await client.query(
      `INSERT INTO sale_lines (sale_id, product_id, description, category, quantity, unit_cents, total_cents, taxable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [saleId, l.productId, l.description, l.category, l.quantity, l.unitCents, l.unitCents * l.quantity, l.taxable],
    );
    const p = l.productId ? products.get(l.productId) : undefined;
    if (p?.track_stock) {
      p.stock -= l.quantity;
      await client.query("UPDATE products SET stock = $2 WHERE id = $1", [p.id, p.stock]);
      await recordMovement(client, p.id, -l.quantity, p.stock, "sale", saleId, null, staffId);
    }
  }
  // Golfers earn loyalty points on what they buy (not on comps, which they didn't pay for).
  if (input.golferId && input.paymentMethod !== "comp") await earnPoints(client, course, input.golferId, subtotal, "sale", { saleId, staffId });
  return saleId;
}

export async function getSale(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(
    `SELECT s.*, u.name AS staff_name, c.name AS golfer_name FROM sales s
       LEFT JOIN staff_users u ON u.id = s.staff_user_id LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = $1 AND s.course_id = $2`,
    [id, course.id],
  );
  if (!rows[0]) throw notFound("Sale");
  const { rows: lines } = await db.query("SELECT * FROM sale_lines WHERE sale_id = $1 ORDER BY description", [id]);
  return toSale(rows[0], lines);
}

function toSale(r: any, lines: any[]) {
  return {
    id: r.id,
    number: r.number,
    at: r.created_at.toISOString(),
    staff: r.staff_name ?? null,
    golfer: r.customer_id ? { id: r.customer_id, name: r.golfer_name } : null,
    subtotalCents: r.subtotal_cents,
    taxCents: r.tax_cents,
    totalCents: r.total_cents,
    paymentMethod: r.payment_method as SalePaymentMethod,
    status: r.status as "completed" | "refunded",
    lines: lines.map((l) => ({
      productId: l.product_id,
      description: l.description,
      category: l.category,
      quantity: l.quantity,
      unitCents: l.unit_cents,
      totalCents: l.total_cents,
      taxable: l.taxable,
    })),
  };
}

/** One day's sales at the register, newest first, with the day's totals. */
export async function listSales(db: DbClient, course: Course, date: string) {
  const start = DateTime.fromISO(date, { zone: course.timeZone }).startOf("day");
  if (!start.isValid) throw badRequest("invalid_date", "Use a date like 2026-10-29");
  const { rows } = await db.query(
    `SELECT s.*, u.name AS staff_name, c.name AS golfer_name FROM sales s
       LEFT JOIN staff_users u ON u.id = s.staff_user_id LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.course_id = $1 AND s.created_at >= $2 AND s.created_at < $3 ORDER BY s.created_at DESC`,
    [course.id, start.toUTC().toISO(), start.plus({ days: 1 }).toUTC().toISO()],
  );
  const { rows: lines } = rows.length
    ? await db.query("SELECT * FROM sale_lines WHERE sale_id = ANY($1) ORDER BY description", [rows.map((r) => r.id)])
    : { rows: [] as any[] };
  const sales = rows.map((r) => toSale(r, lines.filter((l) => l.sale_id === r.id)));
  const kept = sales.filter((s) => s.status === "completed");
  const sum = (list: { totalCents: number }[]) => list.reduce((t, x) => t + x.totalCents, 0);
  const group = <K extends string>(keys: K[], pick: (k: K) => number) => Object.fromEntries(keys.map((k) => [k, pick(k)])) as Record<K, number>;
  const methods = [...new Set(kept.map((s) => s.paymentMethod))];
  const categoryLines = kept.flatMap((s) => s.lines);
  const categories = [...new Set(categoryLines.map((l) => l.category))];
  return {
    sales,
    summary: {
      count: kept.length,
      subtotalCents: kept.reduce((t, s) => t + s.subtotalCents, 0),
      taxCents: kept.reduce((t, s) => t + s.taxCents, 0),
      totalCents: sum(kept),
      refundedCents: sum(sales.filter((s) => s.status === "refunded")),
      byMethod: group(methods, (m) => sum(kept.filter((s) => s.paymentMethod === m))),
      byCategory: group(categories, (c) => sum(categoryLines.filter((l) => l.category === c))),
    },
  };
}

/** Refunds a whole sale (managers only) and puts stocked items back on the shelf. */
export async function refundSale(
  db: Db,
  course: Course,
  staffId: string | undefined,
  id: string,
  /** Puts the money back on the card, for sales paid on a connected reader. */
  refundCard?: (client: DbClient, cardPaymentId: string, amountCents: number) => Promise<unknown>,
) {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query("SELECT status, total_cents, card_payment_id FROM sales WHERE id = $1 AND course_id = $2 FOR UPDATE", [id, course.id]);
    if (!rows[0]) throw notFound("Sale");
    if (rows[0].status === "refunded") throw conflict("already_refunded", "This sale was already refunded");
    if (rows[0].card_payment_id && refundCard) await refundCard(client, rows[0].card_payment_id, rows[0].total_cents);
    await reverseSalePoints(client, course, id, staffId);
    await client.query("UPDATE sales SET status = 'refunded', refunded_at = now(), refunded_by = $2 WHERE id = $1", [id, staffId ?? null]);
    const { rows: lines } = await client.query(
      `SELECT l.product_id, l.quantity FROM sale_lines l JOIN products p ON p.id = l.product_id
        WHERE l.sale_id = $1 AND p.track_stock ORDER BY l.product_id`,
      [id],
    );
    for (const l of lines) {
      const { rows: p } = await client.query("UPDATE products SET stock = stock + $2 WHERE id = $1 RETURNING stock", [l.product_id, l.quantity]);
      await recordMovement(client, l.product_id, l.quantity, p[0].stock, "refund", id, null, staffId);
    }
  });
  return getSale(db, course, id);
}

export async function getPosSettings(db: DbClient, course: Course) {
  const { rows } = await db.query("SELECT sales_tax_bps FROM courses WHERE id = $1", [course.id]);
  return { salesTaxBps: rows[0].sales_tax_bps as number };
}

export async function savePosSettings(db: DbClient, course: Course, settings: { salesTaxBps: number }) {
  await db.query("UPDATE courses SET sales_tax_bps = $2 WHERE id = $1", [course.id, settings.salesTaxBps]);
  return getPosSettings(db, course);
}
