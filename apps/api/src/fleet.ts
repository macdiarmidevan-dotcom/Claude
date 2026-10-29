import type { Course } from "./courses.ts";
import { withTransaction, type Db, type DbClient } from "./db.ts";
import { badRequest, conflict, notFound } from "./errors.ts";

// The cart fleet, maintenance equipment, and work orders for anything that needs fixing. Carts are
// counted in rounds between services from the cart numbers the starter assigns, so service comes
// due on its own. Anyone on staff can report a problem and take a cart out of service; managers
// set up the fleet.

export type AssetKind = "cart" | "equipment";
export type AssetStatus = "in_service" | "out_of_service" | "retired";
export type WorkOrderStatus = "open" | "in_progress" | "on_hold" | "done" | "cancelled";
export type WorkOrderArea = "carts" | "equipment" | "course" | "clubhouse" | "other";
export type Priority = "low" | "normal" | "high" | "urgent";

const OPEN_STATUSES: WorkOrderStatus[] = ["open", "in_progress", "on_hold"];
/** A cart that was never marked back in counts as back this long after its group teed off. */
const OUT_HOURS = 6;

export interface Asset {
  id: string;
  kind: AssetKind;
  number: string;
  model: string | null;
  power: "gas" | "electric" | "diesel" | "other" | null;
  serial: string | null;
  status: AssetStatus;
  statusNote: string | null;
  statusChangedAt: string;
  serviceEvery: number | null;
  hours: number | null;
  lastServiceAt: string | null;
  /** Carts: rounds since the last service. Equipment: hours since it. */
  sinceService: number;
  serviceDue: boolean;
  openWorkOrders: number;
  /** A cart that's out on the course now. */
  out: { bookingId: string; name: string; teedOffAt: string } | null;
  notes: string | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const ASSET_SELECT = `
  SELECT a.*,
    (SELECT count(*)::int FROM work_orders w WHERE w.asset_id = a.id AND w.status IN ('open', 'in_progress', 'on_hold')) AS open_orders,
    CASE WHEN a.kind = 'cart' THEN (
      SELECT count(*)::int FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id
       WHERE b.course_id = a.course_id AND b.status IN ('checked_in', 'teed_off') AND a.number = ANY (b.cart_numbers)
         AND COALESCE(b.teed_off_at, t.starts_at) BETWEEN COALESCE(a.last_service_at, a.created_at) AND now()
    ) END AS rounds,
    out.booking_id AS out_booking, out.name AS out_name, out.teed_off_at AS out_at
  FROM fleet_assets a
  LEFT JOIN LATERAL (
    SELECT b.id AS booking_id, c.name, b.teed_off_at FROM bookings b JOIN customers c ON c.id = b.customer_id
     WHERE a.kind = 'cart' AND b.course_id = a.course_id AND b.status = 'teed_off' AND a.number = ANY (b.cart_numbers)
       AND b.carts_in_at IS NULL AND b.teed_off_at > now() - interval '${OUT_HOURS} hours'
     ORDER BY b.teed_off_at DESC LIMIT 1
  ) out ON true`;

const toAsset = (r: any): Asset => {
  const hours = num(r.hours);
  const sinceService = r.kind === "cart" ? (r.rounds ?? 0) : Math.max(0, Math.round(((hours ?? 0) - (num(r.last_service_hours) ?? 0)) * 10) / 10);
  return {
    id: r.id,
    kind: r.kind,
    number: r.number,
    model: r.model,
    power: r.power,
    serial: r.serial,
    status: r.status,
    statusNote: r.status_note,
    statusChangedAt: r.status_changed_at.toISOString(),
    serviceEvery: r.service_every,
    hours,
    lastServiceAt: r.last_service_at?.toISOString() ?? null,
    sinceService,
    serviceDue: r.status !== "retired" && !!r.service_every && sinceService >= r.service_every,
    openWorkOrders: r.open_orders,
    out: r.out_booking ? { bookingId: r.out_booking, name: r.out_name, teedOffAt: r.out_at.toISOString() } : null,
    notes: r.notes,
  };
};

// Cart numbers sort as numbers where they are ones ("2" before "10").
const byNumber = (a: Asset, b: Asset) => a.number.localeCompare(b.number, undefined, { numeric: true });

export async function listAssets(db: DbClient, course: Course, opts: { kind?: AssetKind; retired?: boolean } = {}) {
  const { rows } = await db.query(`${ASSET_SELECT} WHERE a.course_id = $1 AND ($2::text IS NULL OR a.kind = $2) AND ($3 OR a.status <> 'retired')`, [
    course.id,
    opts.kind ?? null,
    !!opts.retired,
  ]);
  return rows.map(toAsset).sort((a, b) => a.kind.localeCompare(b.kind) || byNumber(a, b));
}

async function assetRow(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(`${ASSET_SELECT} WHERE a.id = $1 AND a.course_id = $2`, [id, course.id]);
  if (!rows[0]) throw notFound("Cart or equipment");
  return toAsset(rows[0]);
}

export async function getAsset(db: DbClient, course: Course, id: string) {
  const asset = await assetRow(db, course, id);
  const { rows: service } = await db.query(
    `SELECT s.*, u.name AS staff, w.number AS order_number FROM fleet_service s
       LEFT JOIN staff_users u ON u.id = s.staff_user_id LEFT JOIN work_orders w ON w.id = s.work_order_id
      WHERE s.asset_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
    [id],
  );
  const orders = await listWorkOrders(db, course, { assetId: id, status: "all" });
  return {
    ...asset,
    service: service.map((s) => ({
      id: s.id,
      kind: s.kind as "service" | "repair" | "inspection",
      note: s.note,
      costCents: s.cost_cents,
      hours: num(s.hours),
      workOrderNumber: s.order_number ?? null,
      staff: s.staff ?? null,
      at: s.created_at.toISOString(),
    })),
    workOrders: orders.slice(0, 20),
  };
}

export interface AssetInput {
  kind: AssetKind;
  number: string;
  model?: string | null;
  power?: Asset["power"];
  serial?: string | null;
  serviceEvery?: number | null;
  hours?: number | null;
  notes?: string | null;
}

const duplicate = (kind: AssetKind, number: string) =>
  conflict("asset_exists", kind === "cart" ? `There's already a cart ${number}` : `There's already equipment called ${number}`);

export async function createAsset(db: DbClient, course: Course, input: AssetInput) {
  const { rows } = await db.query(
    `INSERT INTO fleet_assets (course_id, kind, number, model, power, serial, service_every, hours, last_service_hours, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) ON CONFLICT (course_id, kind, number) DO NOTHING RETURNING id`,
    [course.id, input.kind, input.number, input.model ?? null, input.power ?? null, input.serial ?? null, input.serviceEvery ?? null, input.hours ?? null, input.notes ?? null],
  );
  if (!rows[0]) throw duplicate(input.kind, input.number);
  return assetRow(db, course, rows[0].id);
}

/** Adds carts numbered from..to in one go, skipping numbers already in the fleet. */
export async function addCarts(db: DbClient, course: Course, input: { from: number; to: number; model?: string | null; power?: Asset["power"]; serviceEvery?: number | null }) {
  if (input.to < input.from) throw badRequest("invalid_range", "The last number has to be at or after the first");
  if (input.to - input.from >= 200) throw badRequest("too_many", "Add up to 200 carts at a time");
  const numbers = Array.from({ length: input.to - input.from + 1 }, (_, i) => String(input.from + i));
  const { rowCount } = await db.query(
    `INSERT INTO fleet_assets (course_id, kind, number, model, power, service_every)
     SELECT $1, 'cart', n, $3, $4, $5 FROM unnest($2::text[]) n ON CONFLICT (course_id, kind, number) DO NOTHING`,
    [course.id, numbers, input.model ?? null, input.power ?? null, input.serviceEvery ?? null],
  );
  return { added: rowCount ?? 0, carts: await listAssets(db, course, { kind: "cart" }) };
}

export async function updateAsset(db: DbClient, course: Course, id: string, input: Partial<Omit<AssetInput, "kind">> & { retired?: boolean }) {
  const before = await assetRow(db, course, id);
  const sets: string[] = [];
  const values: unknown[] = [id, course.id];
  const set = (col: string, v: unknown) => (values.push(v), sets.push(`${col} = $${values.length}`));
  if (input.number !== undefined) set("number", input.number);
  if (input.model !== undefined) set("model", input.model);
  if (input.power !== undefined) set("power", input.power);
  if (input.serial !== undefined) set("serial", input.serial);
  if (input.serviceEvery !== undefined) set("service_every", input.serviceEvery);
  if (input.hours !== undefined) set("hours", input.hours);
  if (input.notes !== undefined) set("notes", input.notes);
  if (input.retired !== undefined && input.retired !== (before.status === "retired")) {
    set("status", input.retired ? "retired" : "in_service");
    sets.push("status_note = NULL", "status_changed_at = now()");
  }
  if (sets.length) {
    try {
      await db.query(`UPDATE fleet_assets SET ${sets.join(", ")} WHERE id = $1 AND course_id = $2`, values);
    } catch (e: any) {
      if (e.code === "23505") throw duplicate(before.kind, input.number!);
      throw e;
    }
  }
  return assetRow(db, course, id);
}

/** Takes a cart or machine out of service (with why) or puts it back. Anyone on staff can. */
export async function setAssetStatus(db: DbClient, course: Course, id: string, input: { status: "in_service" | "out_of_service"; note?: string | null }) {
  const before = await assetRow(db, course, id);
  if (before.status === "retired") throw conflict("retired", "This one is retired. A manager can bring it back in the fleet settings");
  if (input.status === "out_of_service" && !input.note?.trim()) throw badRequest("note_required", "Say what's wrong so whoever fixes it knows");
  await db.query("UPDATE fleet_assets SET status = $3, status_note = $4, status_changed_at = now() WHERE id = $1 AND course_id = $2", [
    id,
    course.id,
    input.status,
    input.status === "out_of_service" ? input.note!.trim() : null,
  ]);
  return assetRow(db, course, id);
}

/** Records a service, repair or inspection. A service restarts the count toward the next one. */
export async function logService(
  db: Db,
  course: Course,
  staffId: string | undefined,
  id: string,
  input: { kind: "service" | "repair" | "inspection"; note?: string | null; costCents?: number; hours?: number | null; workOrderId?: string | null },
) {
  const asset = await assetRow(db, course, id);
  if (input.hours != null && asset.hours != null && input.hours < asset.hours) throw badRequest("hours_back", `The meter was at ${asset.hours} hours. It can't go back`);
  await withTransaction(db, async (client) => {
    await client.query(
      `INSERT INTO fleet_service (asset_id, kind, note, cost_cents, hours, work_order_id, staff_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, input.kind, input.note?.trim() || null, input.costCents ?? 0, input.hours ?? asset.hours, input.workOrderId ?? null, staffId ?? null],
    );
    if (input.hours != null) await client.query("UPDATE fleet_assets SET hours = $2 WHERE id = $1", [id, input.hours]);
    if (input.kind === "service") await client.query("UPDATE fleet_assets SET last_service_at = now(), last_service_hours = hours WHERE id = $1", [id]);
  });
  return getAsset(db, course, id);
}

/** Reads the hour meter on a machine. */
export async function setHours(db: DbClient, course: Course, id: string, hours: number) {
  const asset = await assetRow(db, course, id);
  if (asset.kind !== "equipment") throw badRequest("not_equipment", "Carts are counted in rounds, not hours");
  if (asset.hours != null && hours < asset.hours) throw badRequest("hours_back", `The meter was at ${asset.hours} hours. It can't go back`);
  await db.query("UPDATE fleet_assets SET hours = $2 WHERE id = $1", [id, hours]);
  return assetRow(db, course, id);
}

/**
 * Checks the carts a starter is handing out. With no carts set up, any number goes; once the fleet
 * is set up, a number has to be one of its carts and in service.
 */
export async function checkCartsUsable(client: DbClient, course: Course, numbers: string[]) {
  if (!numbers.length) return;
  const { rows } = await client.query("SELECT number, status, status_note FROM fleet_assets WHERE course_id = $1 AND kind = 'cart'", [course.id]);
  if (!rows.length) return;
  const carts = new Map(rows.map((r) => [r.number as string, r]));
  const unknown = numbers.filter((n) => !carts.has(n));
  if (unknown.length) throw conflict("unknown_cart", `Cart ${unknown.join(", ")} isn't in the fleet. Check the number, or add it under Carts & maintenance`);
  const down = numbers.map((n) => carts.get(n)!).filter((c) => c.status !== "in_service");
  if (down.length)
    throw conflict(
      "cart_out_of_service",
      down.map((c) => `Cart ${c.number} is ${c.status === "retired" ? "retired" : `out of service${c.status_note ? ` (${c.status_note})` : ""}`}`).join(". "),
    );
}

/** The starter marks a group's carts back in, so they show as free again. */
export async function cartsIn(db: DbClient, course: Course, bookingId: string) {
  const { rowCount } = await db.query(
    "UPDATE bookings SET carts_in_at = now() WHERE id = $1 AND course_id = $2 AND status = 'teed_off' AND cardinality(cart_numbers) > 0",
    [bookingId, course.id],
  );
  if (!rowCount) throw conflict("no_carts_out", "This group has no carts out");
  return listAssets(db, course, { kind: "cart" });
}

export interface WorkOrder {
  id: string;
  number: number;
  title: string;
  details: string | null;
  area: WorkOrderArea;
  location: string | null;
  asset: { id: string; kind: AssetKind; number: string } | null;
  priority: Priority;
  status: WorkOrderStatus;
  assignedTo: { id: string; name: string } | null;
  reportedBy: string | null;
  dueDate: string | null;
  overdue: boolean;
  costCents: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ORDER_SELECT = `
  SELECT w.*, a.kind AS asset_kind, a.number AS asset_number, s.name AS assignee, r.name AS reporter, to_char(w.due_date, 'YYYY-MM-DD') AS due
    FROM work_orders w
    LEFT JOIN fleet_assets a ON a.id = w.asset_id
    LEFT JOIN staff_users s ON s.id = w.assigned_to
    LEFT JOIN staff_users r ON r.id = w.reported_by`;

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const toOrder = (r: any, today: string): WorkOrder => ({
  id: r.id,
  number: r.number,
  title: r.title,
  details: r.details,
  area: r.area,
  location: r.location,
  asset: r.asset_id ? { id: r.asset_id, kind: r.asset_kind, number: r.asset_number } : null,
  priority: r.priority,
  status: r.status,
  assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assignee } : null,
  reportedBy: r.reporter ?? null,
  dueDate: r.due,
  overdue: !!r.due && r.due < today && OPEN_STATUSES.includes(r.status),
  costCents: r.cost_cents,
  completedAt: r.completed_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const todayAt = (course: Course) => new Intl.DateTimeFormat("en-CA", { timeZone: course.timeZone }).format(new Date());

export async function listWorkOrders(
  db: DbClient,
  course: Course,
  filter: { status?: "open" | "closed" | "all"; assetId?: string; assignedTo?: string; area?: WorkOrderArea } = {},
) {
  const statuses = filter.status === "closed" ? ["done", "cancelled"] : filter.status === "all" ? null : OPEN_STATUSES;
  const { rows } = await db.query(
    `${ORDER_SELECT} WHERE w.course_id = $1 AND ($2::text[] IS NULL OR w.status = ANY ($2)) AND ($3::uuid IS NULL OR w.asset_id = $3)
        AND ($4::uuid IS NULL OR w.assigned_to = $4) AND ($5::text IS NULL OR w.area = $5)
      ORDER BY w.updated_at DESC LIMIT 200`,
    [course.id, statuses, filter.assetId ?? null, filter.assignedTo ?? null, filter.area ?? null],
  );
  const today = todayAt(course);
  const list = rows.map((r) => toOrder(r, today));
  // Open work: most urgent first, then the oldest. Closed work: most recently finished first.
  if (filter.status !== "closed" && filter.status !== "all")
    list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Number(b.overdue) - Number(a.overdue) || a.createdAt.localeCompare(b.createdAt));
  return list;
}

export async function getWorkOrder(db: DbClient, course: Course, id: string) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE w.id = $1 AND w.course_id = $2`, [id, course.id]);
  if (!rows[0]) throw notFound("Work order");
  const { rows: notes } = await db.query(
    `SELECT n.*, u.name AS staff FROM work_order_notes n LEFT JOIN staff_users u ON u.id = n.staff_user_id WHERE n.work_order_id = $1 ORDER BY n.created_at`,
    [id],
  );
  return {
    ...toOrder(rows[0], todayAt(course)),
    notes: notes.map((n) => ({ id: n.id, note: n.note, status: n.status as WorkOrderStatus | null, staff: n.staff ?? null, at: n.created_at.toISOString() })),
  };
}

export interface WorkOrderInput {
  title: string;
  details?: string | null;
  area: WorkOrderArea;
  location?: string | null;
  assetId?: string | null;
  priority?: Priority;
  assignedTo?: string | null;
  dueDate?: string | null;
  /** Also take the cart or machine out of service until the work is done. */
  outOfService?: boolean;
}

async function checkAssignee(client: DbClient, course: Course, staffId: string | null | undefined) {
  if (!staffId) return;
  const { rowCount } = await client.query("SELECT 1 FROM staff_users WHERE id = $1 AND course_id = $2 AND active", [staffId, course.id]);
  if (!rowCount) throw badRequest("unknown_staff", "Pick someone on staff to do the work");
}

/** Anyone on staff can report a problem. */
export async function createWorkOrder(db: Db, course: Course, staffId: string | undefined, input: WorkOrderInput) {
  const id = await withTransaction(db, async (client) => {
    let asset: Asset | undefined;
    if (input.assetId) asset = await assetRow(client, course, input.assetId);
    if (input.outOfService && !asset) throw badRequest("no_asset", "Pick the cart or machine to take out of service");
    await checkAssignee(client, course, input.assignedTo);
    // Numbers count up per course; the lock keeps two reports at once from taking the same one.
    await client.query("SELECT 1 FROM courses WHERE id = $1 FOR UPDATE", [course.id]);
    const { rows } = await client.query(
      `INSERT INTO work_orders (course_id, number, title, details, area, location, asset_id, priority, assigned_to, reported_by, due_date)
       VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM work_orders WHERE course_id = $1), $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        course.id,
        input.title,
        input.details?.trim() || null,
        asset ? (asset.kind === "cart" ? "carts" : "equipment") : input.area,
        input.location?.trim() || null,
        asset?.id ?? null,
        input.priority ?? "normal",
        input.assignedTo ?? null,
        staffId ?? null,
        input.dueDate ?? null,
      ],
    );
    if (input.outOfService && asset!.status === "in_service")
      await client.query("UPDATE fleet_assets SET status = 'out_of_service', status_note = $2, status_changed_at = now() WHERE id = $1", [asset!.id, input.title]);
    return rows[0].id as string;
  });
  return getWorkOrder(db, course, id);
}

export async function updateWorkOrder(
  db: DbClient,
  course: Course,
  id: string,
  input: Partial<Pick<WorkOrderInput, "title" | "details" | "location" | "priority" | "assignedTo" | "dueDate">> & { costCents?: number },
) {
  await getWorkOrder(db, course, id);
  await checkAssignee(db, course, input.assignedTo);
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [id];
  const set = (col: string, v: unknown) => (values.push(v), sets.push(`${col} = $${values.length}`));
  if (input.title !== undefined) set("title", input.title);
  if (input.details !== undefined) set("details", input.details?.trim() || null);
  if (input.location !== undefined) set("location", input.location?.trim() || null);
  if (input.priority !== undefined) set("priority", input.priority);
  if (input.assignedTo !== undefined) set("assigned_to", input.assignedTo);
  if (input.dueDate !== undefined) set("due_date", input.dueDate);
  if (input.costCents !== undefined) set("cost_cents", input.costCents);
  await db.query(`UPDATE work_orders SET ${sets.join(", ")} WHERE id = $1`, values);
  return getWorkOrder(db, course, id);
}

/**
 * Moves a work order along, with an optional note. Finishing one on a cart or machine can put it
 * back in service and record the repair in its history. Only managers cancel work orders.
 */
export async function setWorkOrderStatus(
  db: Db,
  course: Course,
  staffId: string | undefined,
  id: string,
  input: { status: WorkOrderStatus; note?: string | null; backInService?: boolean; costCents?: number },
  isManager: boolean,
) {
  const order = await getWorkOrder(db, course, id);
  if (input.status === "cancelled" && !isManager) throw conflict("manager_only", "Only a manager can cancel a work order");
  if (input.status === order.status) throw conflict("same_status", "The work order is already at that step");
  if (input.status === "done" && order.status === "cancelled") throw conflict("cancelled", "This work order was cancelled. Open it again first");
  await withTransaction(db, async (client) => {
    const done = input.status === "done";
    await client.query(
      `UPDATE work_orders SET status = $2, updated_at = now(), completed_at = CASE WHEN $3 THEN now() ELSE NULL END, cost_cents = COALESCE($4, cost_cents) WHERE id = $1`,
      [id, input.status, done, input.costCents ?? null],
    );
    await client.query("INSERT INTO work_order_notes (work_order_id, staff_user_id, note, status) VALUES ($1, $2, $3, $4)", [
      id,
      staffId ?? null,
      input.note?.trim() || null,
      input.status,
    ]);
    if (done && order.asset) {
      await client.query(
        `INSERT INTO fleet_service (asset_id, kind, note, cost_cents, hours, work_order_id, staff_user_id)
         SELECT $1, 'repair', $2, $3, hours, $4, $5 FROM fleet_assets WHERE id = $1`,
        [order.asset.id, input.note?.trim() || order.title, input.costCents ?? order.costCents, id, staffId ?? null],
      );
      if (input.backInService)
        await client.query("UPDATE fleet_assets SET status = 'in_service', status_note = NULL, status_changed_at = now() WHERE id = $1 AND status = 'out_of_service'", [
          order.asset.id,
        ]);
    }
  });
  return getWorkOrder(db, course, id);
}

export async function addWorkOrderNote(db: DbClient, course: Course, staffId: string | undefined, id: string, note: string) {
  await getWorkOrder(db, course, id);
  await db.query("INSERT INTO work_order_notes (work_order_id, staff_user_id, note) VALUES ($1, $2, $3)", [id, staffId ?? null, note.trim()]);
  await db.query("UPDATE work_orders SET updated_at = now() WHERE id = $1", [id]);
  return getWorkOrder(db, course, id);
}
