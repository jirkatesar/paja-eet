import { nowIso } from "./lib/xmlsign";
import * as db from "./lib/db";
import type { EetStatus } from "./lib/db";
import { ADMIN_HTML } from "./lib/adminPage";
import { ADMIN_CONFIG_HTML } from "./lib/adminConfigPage";
import { attemptSubmit, normalizeAmount, reportSale, type EetEnv } from "./lib/reportSale";
import { runFioPollIfDue } from "./lib/fio";
import { fillVoucher } from "./lib/voucher";
import {
  createPaymentOrder,
  editPaymentOrder,
  retryDeliveries,
  orderTtlDays,
  MATCH_FAILURE_PREFIX,
  type PaymentOrderEnv,
} from "./lib/paymentOrder";
import type { PaymentOrderRow, PaymentOrderStatus } from "./lib/db";
import { buildConfigPatch, describeConfig, resolveFio, type FioEnvSource } from "./lib/appConfig";
import { pragueDayRangeUtc } from "./lib/pragueTime";

export interface Env extends EetEnv, PaymentOrderEnv, FioEnvSource {
  EET_API_TOKEN: string;
  /** Password for the GET /admin web dashboard — set via `wrangler secret put ADMIN_PASSWORD`. Login only works while this is set. */
  ADMIN_PASSWORD?: string;
}

/**
 * The one thing in `lastError` a till should ever see.
 *
 * The column carries two unrelated kinds of bad news: a payment that arrived and
 * did not fit (written by `noteMatchFailure`), and a receipt the mailer could not
 * send. The first is the customer's problem and belongs on the phone — the
 * customer believes they have paid. The second is the operator's, and on a row
 * that already says the money is in it is only noise, so it stays in the
 * dashboard, where mail problems are diagnosed.
 */
function matchProblemOf(order: PaymentOrderRow): string | null {
  return order.lastError?.startsWith(MATCH_FAILURE_PREFIX) ? order.lastError : null;
}

/** The order fields a caller gets back — internal columns stay internal. */
function orderResponse(order: PaymentOrderRow) {
  return {
    id: order.id,
    variableSymbol: order.variableSymbol,
    amountCzk: order.amountCzk,
    constantSymbol: order.constantSymbol,
    kind: order.kind,
    email: order.email,
    paymentMethod: order.paymentMethod,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    sentAt: order.sentAt,
    lastError: order.lastError,
    matchProblem: matchProblemOf(order),
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
/** `GET /orders` — the app's own list, which is read on a phone screen and is never the whole history. */
const DEFAULT_ORDER_LIMIT = 50;
const MAX_ORDER_LIMIT = 200;

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
      const released = await db.expireOrders(env.DB, orderTtlDays(env));
      if (released > 0) console.log(`Orders: expired ${released} unpaid order(s), their symbols are free again`);

      // Payments no order ever claimed. They are only useful while an order might
      // still be made for them, and keeping them forever would grow the table
      // with money nobody accounted for.
      const dropped = await db.pruneUnmatchedPayments(env.DB, resolveFio(env, await db.getAppConfig(env.DB)).unmatchedTtlDays);
      if (dropped > 0) console.log(`Fio poll: dropped ${dropped} payment(s) no order ever claimed`);
    } catch (err) {
      console.error("Order expiry failed:", err instanceof Error ? err.message : String(err));
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
      const sent = await retryDeliveries(env);
      if (sent > 0) console.log(`Orders: delivered ${sent} pending mail(s)`);
    } catch (err) {
      console.error("Delivery retry failed:", err instanceof Error ? err.message : String(err));
    }
  },
} satisfies ExportedHandler<Env>;

/** The `id` a delete request is for, or null when the body is not usable. */
async function readId(request: Request): Promise<number | null> {
  try {
    const body = (await request.json()) as { id?: unknown };
    const id = Number(body.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

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

  // Creates a payment order for a sale — a voucher or a service. With
  // `cash: true` it is settled and mailed in this same request; otherwise it
  // waits for the Fio poll to match the incoming bank transfer. Either way what
  // goes out is the receipt, plus the voucher PDF when `kind` is VOUCHER.
  //
  // `/voucher/order` is the name this had when only vouchers existed; it stays
  // as an alias because an app already installed on a phone would otherwise
  // stop creating orders the moment this Worker is deployed, and vouchers would
  // quietly stop being delivered.
  if (request.method === "POST" && (url.pathname === "/order" || url.pathname === "/voucher/order")) {
    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const result = await createPaymentOrder(env, body);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json(orderResponse(result.order), 201);
  }

  // The till's own list of what it is still waiting to be paid: orders made from
  // the app whose money has not arrived. Bearer auth is EET_API_TOKEN — the
  // credential the app already holds, so nothing new has to reach a phone.
  //
  // Oldest first, unlike the dashboard's orders table: the reason to look at this
  // list at all is that something has been outstanding a while, and the order at
  // the top is the one closest to expiring. `ttlDays` comes back with the rows so
  // the app can say when that is instead of hardcoding the Worker's setting.
  if (request.method === "GET" && url.pathname === "/orders") {
    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);

    // Still a filter rather than a hardcoded PENDING: this is the same table the
    // dashboard reads, and the app is allowed to ask what became of an order.
    // `ALL` is accepted for the same reason it is on `/admin/orders` — the two
    // endpoints read one table, and a filter that works on one and 400s on the
    // other is a trap rather than a restriction.
    const statusParam = url.searchParams.get("status") ?? "PENDING";
    if (statusParam !== "ALL" && !ORDER_STATUS_VALUES.includes(statusParam as PaymentOrderStatus)) {
      return json({ error: "invalid_status" }, 400);
    }

    // `date` is a Prague calendar day, and it means the day the sale was *made*
    // — when somebody stood at the counter, not when the money turned up. That
    // is the day the till's own history is about, and it keeps a transfer that
    // settles two days later in the day it belongs to. The timezone conversion
    // happens here rather than in the app so that every caller means the same
    // thing by "that day"; see `pragueDayRangeUtc`.
    const dateParam = url.searchParams.get("date");
    let range: { from: string; to: string } | null = null;
    if (dateParam !== null) {
      range = pragueDayRangeUtc(dateParam);
      if (!range) return json({ error: "invalid_date" }, 400);
    }

    const limitParam = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.trunc(limitParam), MAX_ORDER_LIMIT) : DEFAULT_ORDER_LIMIT;

    const rows = await db.listPaymentOrders(env.DB, {
      status: statusParam as PaymentOrderStatus,
      limit,
      oldestFirst: true,
      createdFrom: range?.from,
      createdBefore: range?.to,
    });
    // `date` is echoed back on purpose: a Worker that predates this parameter
    // ignores it silently and answers with every day's orders, which looks
    // exactly like a filter that does not work. The app compares the echo with
    // the day it asked for and says so instead of showing the wrong day's money.
    return json({ rows: rows.map(orderResponse), ttlDays: orderTtlDays(env), date: dateParam });
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

  // The configuration page itself is a public shell like /admin; the data behind
  // it is not. Secrets are never returned — only whether they are set.
  if (request.method === "GET" && url.pathname === "/admin/config") {
    return new Response(ADMIN_CONFIG_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (request.method === "GET" && url.pathname === "/admin/config/data") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
    return json(describeConfig(env, await db.getAppConfig(env.DB)));
  }

  if (request.method === "POST" && url.pathname === "/admin/config/data") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const row = await db.getAppConfig(env.DB);
    const result = buildConfigPatch(body, env, row);
    if (!result.ok) return json({ error: result.error }, 400);

    await db.updateAppConfig(env.DB, result.patch);
    return json(describeConfig(env, await db.getAppConfig(env.DB)));
  }

  // Puts every setting back on its environment value — the way out of a
  // configuration that has been fiddled into a corner.
  if (request.method === "POST" && url.pathname === "/admin/config/reset") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
    await db.resetAppConfig(env.DB);
    return json(describeConfig(env, await db.getAppConfig(env.DB)));
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

    const rows = await db.listPaymentOrders(env.DB, { status: statusParam as PaymentOrderStatus | "ALL", limit });
    return json({ rows });
  }

  // Deleting a record is destructive and irreversible, so it is its own
  // endpoint rather than something a stray GET could reach, and it answers 404
  // when the id is gone instead of pretending it worked.
  if (request.method === "POST" && url.pathname === "/admin/data/delete") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
    const id = await readId(request);
    if (id === null) return json({ error: "invalid_json" }, 400);
    return (await db.deleteEetSale(env.DB, id)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }

  // The dashboard's "Nová objednávka" — an order typed in by hand, for a sale
  // that happened away from the till (a transfer agreed over the phone, or a
  // payment that arrived with no order to match). Accepts either credential, so
  // the operator never has to hold the machine token; the validation and the
  // delivery that follows are the same code path the app's own `/order` uses.
  if (request.method === "POST" && url.pathname === "/admin/orders") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const result = await createPaymentOrder(env, body);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json(orderResponse(result.order), 201);
  }

  // Editing an order — see `editPaymentOrder` for what may change once the
  // money is in. `id` is read from the body rather than the path so this stays
  // a POST like its create/delete siblings.
  if (request.method === "POST" && url.pathname === "/admin/orders/update") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "invalid_id" }, 400);

    const result = await editPaymentOrder(env, id, body);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json(orderResponse(result.order));
  }

  if (request.method === "POST" && url.pathname === "/admin/orders/delete") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
    const id = await readId(request);
    if (id === null) return json({ error: "invalid_json" }, 400);
    return (await db.deletePaymentOrder(env.DB, id)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }

  if (request.method === "GET" && url.pathname === "/fio/status") {
    if (!checkAdminAuth(request, env)) return json({ error: "unauthorized" }, 401);
    const state = await db.getFioState(env.DB);
    // `enabled` reflects the *effective* setting, which the config page can
    // override — a token being present is no longer the whole story.
    const fio = resolveFio(env, await db.getAppConfig(env.DB));
    // `tokenSet` lets the dashboard explain *why* it is off — a switch in the
    // settings versus a missing credential are different problems.
    return json({ enabled: fio.enabled, tokenSet: fio.token !== null, ...state });
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
