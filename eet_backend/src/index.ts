import { nowIso } from "./lib/xmlsign";
import * as db from "./lib/db";
import type { EetStatus } from "./lib/db";
import { ADMIN_HTML } from "./lib/adminPage";
import { attemptSubmit, normalizeAmount, reportSale, type EetEnv } from "./lib/reportSale";
import { runFioPollIfDue } from "./lib/fio";
import { fillVoucher } from "./lib/voucher";
import { createVoucherOrder, retryVoucherDeliveries, voucherOrderTtlDays, type VoucherOrderEnv } from "./lib/voucherOrder";
import type { VoucherOrderRow, VoucherOrderStatus } from "./lib/db";

export interface Env extends EetEnv, VoucherOrderEnv {
  EET_API_TOKEN: string;
  /** Fio Banka API token (§5.2.3 of the Fio API docs) — set via `wrangler secret put FIO_TOKEN`. Fio poll stays off (no-op) when unset. */
  FIO_TOKEN?: string;
  /** Minimum seconds between Fio polls; clamped to a 30s floor. Defaults to 45 when unset/invalid. */
  FIO_POLL_INTERVAL_SECONDS?: string;
  /** Password for the GET /admin web dashboard — set via `wrangler secret put ADMIN_PASSWORD`. Login only works while this is set. */
  ADMIN_PASSWORD?: string;
}

/** The order fields a caller gets back — internal columns stay internal. */
function orderResponse(order: VoucherOrderRow) {
  return {
    id: order.id,
    variableSymbol: order.variableSymbol,
    amountCzk: order.amountCzk,
    constantSymbol: order.constantSymbol,
    email: order.email,
    paymentMethod: order.paymentMethod,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    sentAt: order.sentAt,
    lastError: order.lastError,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Bearer token must equal EET_API_TOKEN — the machine-to-machine API (`/report`, `/status/:reference`). */
function checkAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token.length > 0 && token === env.EET_API_TOKEN;
}

/**
 * Bearer token must equal either EET_API_TOKEN or ADMIN_PASSWORD — the
 * dashboard's own data endpoints (`/admin/data`, `/fio/status`, `/fio/poll`).
 * Accepting EET_API_TOKEN too keeps those endpoints usable for scripted
 * checks (`curl`) without a separate credential; accepting ADMIN_PASSWORD
 * lets a human log into GET /admin without ever handling EET_API_TOKEN.
 */
function checkAdminAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  return token === env.EET_API_TOKEN || (Boolean(env.ADMIN_PASSWORD) && token === env.ADMIN_PASSWORD);
}

/** ZoET's offline-mode reporting deadline: a sale must reach EET within 48h of the sale itself. */
const REPORTING_DEADLINE_HOURS = 48;

/** How many `PENDING` rows one cron run retries — see `listPending` for why the batch is ordered by attempt count. */
const RETRY_BATCH_SIZE = 20;

const STATUS_VALUES = ["PENDING", "SENT", "EXPIRED", "REJECTED"] as const;
const ORDER_STATUS_VALUES = ["PENDING", "PAID", "SENT", "EXPIRED", "CANCELLED"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ADMIN_DATA_LIMIT = 50;
const MAX_ADMIN_DATA_LIMIT = 500;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // Every route otherwise answers JSON, so an unexpected throw (a D1 error, or
      // reportSale's "internal_error") must not escape as Workers' bare 500 page.
      console.error("Unhandled error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // Sweep first, so a row that has aged out is never retried again and can't
    // occupy a slot in the retry batch below.
    const expired = await db.expireOverdue(env.DB, REPORTING_DEADLINE_HOURS);
    for (const reference of expired) {
      console.error(`EET: reference "${reference}" missed the 48h ZoET reporting deadline — needs manual follow-up`);
    }

    const pending = await db.listPending(env.DB, RETRY_BATCH_SIZE);
    for (const row of pending) {
      await attemptSubmit(env, row, false);
    }

    // Cleanup before the poll, so a symbol nobody paid for is released rather
    // than sitting in the matching set.
    try {
      const released = await db.expireVoucherOrders(env.DB, voucherOrderTtlDays(env));
      if (released > 0) console.log(`Voucher orders: expired ${released} unpaid order(s), their symbols are free again`);
    } catch (err) {
      console.error("Voucher order expiry failed:", err instanceof Error ? err.message : String(err));
    }

    try {
      await runFioPollIfDue(env);
    } catch (err) {
      // A Fio-side failure (bad token, API outage) must not block the PENDING retry loop above.
      console.error("Fio poll failed:", err instanceof Error ? err.message : String(err));
    }

    // After the poll, so an order settled (or a cash sale made) in this run and
    // whose mail failed gets its retry here rather than waiting a whole minute.
    try {
      const sent = await retryVoucherDeliveries(env);
      if (sent > 0) console.log(`Voucher orders: delivered ${sent} pending voucher(s)`);
    } catch (err) {
      console.error("Voucher delivery retry failed:", err instanceof Error ? err.message : String(err));
    }
  },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/report") {
    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);

    let body: { reference?: unknown; amountCzk?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const reference = typeof body.reference === "string" ? body.reference.trim().slice(0, 200) : "";
    const amountCzk = normalizeAmount(body.amountCzk);
    if (!reference || amountCzk === null) return json({ error: "reference and amountCzk (positive number) are required" }, 400);

    const outcome = await reportSale(env, reference, amountCzk);
    const statusCode = { sent: 200, pending: 202, expired: 410, rejected: 409 }[outcome.status];
    return json({ reference, ...outcome }, statusCode);
  }

  // Renders a filled gift voucher. Bearer auth is EET_API_TOKEN, the same
  // credential the Android app already sends to /report — issuing a voucher
  // is the same kind of machine-to-machine call.
  if (request.method === "POST" && url.pathname === "/voucher") {
    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);

    let body: { amountCzk?: unknown; voucherNumber?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const amountCzk = Number(body.amountCzk);
    const voucherNumber =
      typeof body.voucherNumber === "number" || typeof body.voucherNumber === "string" ? String(body.voucherNumber).trim() : "";
    if (!voucherNumber || !Number.isFinite(amountCzk) || amountCzk <= 0) {
      return json({ error: "amountCzk (positive number) and voucherNumber are required" }, 400);
    }

    const pdf = await fillVoucher({ amountCzk, voucherNumber });
    // Only [A-Za-z0-9_-] survives into the header — a raw voucherNumber could
    // otherwise inject its own header lines.
    const filename = `poukaz-${voucherNumber.replace(/[^A-Za-z0-9_-]/g, "") || "bez-cisla"}.pdf`;
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // Creates a voucher order. With `cash: true` the voucher is generated and
  // e-mailed in this same request; otherwise the order waits for the Fio poll
  // to match the incoming bank transfer.
  if (request.method === "POST" && url.pathname === "/voucher/order") {
    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const result = await createVoucherOrder(env, body);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json(orderResponse(result.order), 201);
  }

  if (request.method === "GET" && url.pathname.startsWith("/status/")) {
    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);
    const reference = decodeURIComponent(url.pathname.slice("/status/".length));
    const row = await db.findByReference(env.DB, reference);
    if (!row) return json({ error: "not_found" }, 404);
    return json({
      reference: row.reference,
      status: row.status,
      amountCzk: row.amountCzk,
      pok: row.pok,
      test: Boolean(row.test),
      attempts: row.attempts,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  if (request.method === "GET" && url.pathname === "/admin") {
    return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (request.method === "GET" && url.pathname === "/admin/data") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);

    const statusParam = url.searchParams.get("status") ?? "ALL";
    if (statusParam !== "ALL" && !STATUS_VALUES.includes(statusParam as (typeof STATUS_VALUES)[number])) {
      return json({ error: "invalid_status" }, 400);
    }

    // "Today" here is a UTC calendar day (nowIso() is UTC) — callers that care about a
    // specific local day (e.g. the stena-letnak admin page, Europe/Prague) should always
    // pass explicit dateFrom/dateTo rather than relying on this fallback.
    const today = nowIso().slice(0, 10);
    const dateFrom = url.searchParams.get("dateFrom") ?? today;
    const dateTo = url.searchParams.get("dateTo") ?? today;
    if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) return json({ error: "invalid_date" }, 400);

    const limitParam = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.trunc(limitParam), MAX_ADMIN_DATA_LIMIT)
        : DEFAULT_ADMIN_DATA_LIMIT;

    const rows = await db.listFiltered(env.DB, { status: statusParam as EetStatus | "ALL", dateFrom, dateTo, limit });
    return json({ rows });
  }

  if (request.method === "GET" && url.pathname === "/admin/orders") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);

    const statusParam = url.searchParams.get("status") ?? "ALL";
    if (statusParam !== "ALL" && !ORDER_STATUS_VALUES.includes(statusParam as (typeof ORDER_STATUS_VALUES)[number])) {
      return json({ error: "invalid_status" }, 400);
    }

    const limitParam = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.trunc(limitParam), MAX_ADMIN_DATA_LIMIT)
        : DEFAULT_ADMIN_DATA_LIMIT;

    const rows = await db.listVoucherOrders(env.DB, { status: statusParam as VoucherOrderStatus | "ALL", limit });
    return json({ rows });
  }

  if (request.method === "GET" && url.pathname === "/fio/status") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
    const state = await db.getFioState(env.DB);
    return json({ enabled: Boolean(env.FIO_TOKEN), ...state });
  }

  // Manual "check now" trigger (also used by the /admin dashboard's own button) —
  // ignores the IfDue throttle so it's useful for verifying a deployment.
  if (request.method === "POST" && url.pathname === "/fio/poll") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
    try {
      const result = await runFioPollIfDue(env, { force: true });
      return json(result);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  return json({ error: "not_found" }, 404);
}
