import { nowIso } from "./lib/xmlsign";
import * as db from "./lib/db";
import type { EetStatus } from "./lib/db";
import { ADMIN_HTML } from "./lib/adminPage";
import { attemptSubmit, normalizeAmount, reportSale, type EetEnv } from "./lib/reportSale";
import { runFioPollIfDue } from "./lib/fio";

export interface Env extends EetEnv {
  EET_API_TOKEN: string;
  /** Fio Banka API token (§5.2.3 of the Fio API docs) — set via `wrangler secret put FIO_TOKEN`. Fio poll stays off (no-op) when unset. */
  FIO_TOKEN?: string;
  /** Minimum seconds between Fio polls; clamped to a 30s floor. Defaults to 60 when unset/invalid. */
  FIO_POLL_INTERVAL_SECONDS?: string;
  /** Password for the GET /admin web dashboard — set via `wrangler secret put ADMIN_PASSWORD`. Login only works while this is set. */
  ADMIN_PASSWORD?: string;
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
const REPORTING_DEADLINE_MS = 48 * 60 * 60 * 1000;

const STATUS_VALUES = ["PENDING", "SENT", "EXPIRED", "REJECTED"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ADMIN_DATA_LIMIT = 50;
const MAX_ADMIN_DATA_LIMIT = 500;

/** D1's `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" (space-separated, UTC, no zone suffix). */
function sqliteDatetimeMs(s: string): number {
  return new Date(`${s.replace(" ", "T")}Z`).getTime();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const pending = await db.listPending(env.DB, 20);
    for (const row of pending) {
      if (Date.now() - sqliteDatetimeMs(row.createdAt) > REPORTING_DEADLINE_MS) {
        await db.markExpired(env.DB, row.id);
        console.error(`EET: reference "${row.reference}" (id ${row.id}) missed the 48h ZoET reporting deadline — needs manual follow-up`);
        continue;
      }
      await attemptSubmit(env, row, false);
    }

    try {
      await runFioPollIfDue(env);
    } catch (err) {
      // A Fio-side failure (bad token, API outage) must not block the PENDING retry loop above.
      console.error("Fio poll failed:", err instanceof Error ? err.message : String(err));
    }
  },
} satisfies ExportedHandler<Env>;
