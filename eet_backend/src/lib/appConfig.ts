import type { AppConfigRow } from "./db";
import type { SmtpConfig, SmtpSecurity } from "./smtp";

/**
 * Resolves the settings the web configuration page can override.
 *
 * The rule everywhere in here is the same: **a value stored in the database
 * wins; anything unset falls back to the environment, and then to a hard-coded
 * default.** So `wrangler secret` and `wrangler.jsonc` stay the source of truth
 * for a deployment that never touches the page, and "revert to ENV" restores
 * exactly that.
 *
 * Secret fields treat an empty string the same as NULL — that is what lets the
 * form leave them blank without wiping a value it is not allowed to show.
 */

export interface FioEnvSource {
  FIO_TOKEN?: string;
  FIO_POLL_INTERVAL_SECONDS?: string;
  FIO_API_BASE?: string;
  /** Days an unmatched bank payment is kept for a later order. */
  FIO_UNMATCHED_TTL_DAYS?: string;
}

export interface SmtpEnvSource {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_FROM?: string;
  SMTP_FROM_NAME?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
}

/**
 * Fio enforces a hard 30-second minimum between calls on the same token
 * (exceeding it is answered with HTTP 409, doc §6.1) — this floor is that
 * limit, not a preference, which is why the config page refuses to store less.
 *
 * The default sits below the 60s cron tick on purpose: the poll compares
 * against the *previous run*, so an interval of 60s or more would lose roughly
 * every other tick to cron jitter (a tick firing a fraction of a second early
 * finds 59.9s elapsed and skips), silently halving the real poll rate. 45s
 * keeps every tick eligible while still leaving 15s of headroom above Fio's own
 * limit.
 */
export const MIN_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_POLL_INTERVAL_SECONDS = 45;
export const DEFAULT_SMTP_PORT = 465;
export const DEFAULT_FIO_API_BASE = "https://fioapi.fio.cz/v1/rest";

/**
 * How long a bank payment waits for an order that has not been made yet.
 *
 * Long enough that an order finished the next day still finds its payment, and
 * short enough that the table does not keep growing with money nobody ever
 * accounted for. Matches how long an unpaid order holds its symbol.
 */
export const DEFAULT_UNMATCHED_TTL_DAYS = 30;

/** Where an effective value came from — shown on the config page, so the operator can see what they are overriding. */
export type ValueSource = "config" | "env" | "default" | "unset";

export type Resolved<T> = { value: T; source: ValueSource };

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** A stored value wins, then the environment, then the default. */
function pick<T>(stored: T | null | undefined, fromEnv: T | null | undefined, fallback: T): Resolved<T> {
  if (isSet(stored)) return { value: stored as T, source: "config" };
  if (isSet(fromEnv)) return { value: fromEnv as T, source: "env" };
  return { value: fallback, source: "default" };
}

/** Same ordering, but for values that may legitimately stay absent — "unset" is a real answer. */
function pickOptional(stored: string | null, fromEnv: string | undefined): Resolved<string | null> {
  const clean = (value: string | null | undefined) => (isSet(value) ? (value as string).trim() || null : null);
  const fromConfig = clean(stored);
  if (fromConfig) return { value: fromConfig, source: "config" };
  const fromEnvironment = clean(fromEnv);
  if (fromEnvironment) return { value: fromEnvironment, source: "env" };
  return { value: null, source: "unset" };
}

function pickNumber(stored: number | null, fromEnv: string | undefined, fallback: number): Resolved<number> {
  const parsed = fromEnv === undefined || fromEnv === "" ? null : Number(fromEnv);
  return pick(stored, parsed !== null && Number.isFinite(parsed) ? parsed : null, fallback);
}

// ---------------------------------------------------------------------- Fio

export type ResolvedFio = {
  enabled: boolean;
  token: string | null;
  intervalSeconds: number;
  apiBase: string;
  unmatchedTtlDays: number;
  sources: { enabled: ValueSource; token: ValueSource; intervalSeconds: ValueSource; apiBase: ValueSource; unmatchedTtlDays: ValueSource };
};

/**
 * The poll runs only when it is switched on *and* has a token: a token alone is
 * no longer enough, because the page can now turn the poll off without anyone
 * having to remove the credential. With no explicit switch stored, the old rule
 * still applies — a configured token means enabled — so existing deployments
 * behave exactly as before.
 *
 * `FIO_API_BASE` stays environment-only: it exists to point local runs at a
 * stub, not to be operated from a web page.
 */
export function resolveFio(env: FioEnvSource, row: AppConfigRow): ResolvedFio {
  const token = pickOptional(row.fioToken, env.FIO_TOKEN);
  const interval = pickNumber(row.fioPollIntervalSeconds, env.FIO_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS);
  const apiBase = pickOptional(null, env.FIO_API_BASE);
  const unmatchedTtl = pickNumber(row.unmatchedPaymentTtlDays, env.FIO_UNMATCHED_TTL_DAYS, DEFAULT_UNMATCHED_TTL_DAYS);

  const explicitSwitch = row.fioEnabled === null || row.fioEnabled === undefined ? null : row.fioEnabled !== 0;
  const enabled = (explicitSwitch ?? token.value !== null) && token.value !== null;

  return {
    enabled,
    token: token.value,
    intervalSeconds: Math.max(MIN_POLL_INTERVAL_SECONDS, interval.value),
    apiBase: apiBase.value ?? DEFAULT_FIO_API_BASE,
    unmatchedTtlDays: Math.max(1, unmatchedTtl.value),
    sources: {
      enabled: explicitSwitch === null ? "default" : "config",
      token: token.source,
      intervalSeconds: interval.source,
      apiBase: apiBase.source,
      unmatchedTtlDays: unmatchedTtl.source,
    },
  };
}

// --------------------------------------------------------------------- SMTP

/**
 * Port and security describe the same thing from two directions: 465 speaks TLS
 * from the first byte ("tls"), 587 connects in the clear and upgrades
 * ("starttls"). Getting the pair the wrong way round fails inside the
 * handshake, where the runtime reports nothing useful — so it is rejected here,
 * at the point the value is chosen, naming the fix.
 */
export function parseSecurity(value: string | null | undefined, port: number): SmtpSecurity {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized && normalized !== "tls" && normalized !== "starttls" && normalized !== "none") {
    throw new Error(`SMTP_SECURE must be tls, starttls or none (got "${value}")`);
  }
  const security: SmtpSecurity = (normalized as SmtpSecurity) || (port === 587 ? "starttls" : "tls");

  if (port === 587 && security === "tls") {
    throw new Error("SMTP_PORT 587 expects STARTTLS — set SMTP_SECURE=starttls, or switch to port 465 with tls");
  }
  if (port === 465 && security === "starttls") {
    throw new Error("SMTP_PORT 465 speaks TLS from the first byte — set SMTP_SECURE=tls, or switch to port 587 with starttls");
  }
  return security;
}

/** Hosts where an unencrypted connection cannot leave the machine — `sendMail` enforces this independently. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

export type ResolvedSmtp = { config: SmtpConfig; sources: Record<"host" | "port" | "security" | "from" | "fromName" | "user" | "password", ValueSource> };

/**
 * Throws when the mail settings are incomplete or contradictory — the same
 * behaviour as before the config page existed. `fulfilOrder` catches it and
 * records it on the order, so the operator sees it per-voucher rather than as a
 * failed cron run; the config page validates on save so it should never get
 * that far.
 */
export function resolveSmtp(env: SmtpEnvSource, row: AppConfigRow): ResolvedSmtp {
  const host = pickOptional(row.smtpHost, env.SMTP_HOST);
  if (!host.value) throw new Error("SMTP_HOST is not configured");

  const from = pickOptional(row.smtpFrom, env.SMTP_FROM);
  if (!from.value) throw new Error("SMTP_FROM is not configured");

  const port = pickNumber(row.smtpPort, env.SMTP_PORT, DEFAULT_SMTP_PORT);
  // Security has no useful default of its own — it follows the port — so it is
  // only taken from config or environment when actually spelled out.
  const security = pickOptional(row.smtpSecure, env.SMTP_SECURE);
  const fromName = pickOptional(row.smtpFromName, env.SMTP_FROM_NAME);
  const user = pickOptional(row.smtpUser, env.SMTP_USER);
  const password = pickOptional(row.smtpPassword, env.SMTP_PASSWORD);

  return {
    config: {
      host: host.value,
      port: port.value,
      security: parseSecurity(security.value, port.value),
      user: user.value ?? "",
      password: password.value ?? "",
      from: from.value,
      fromName: fromName.value ?? undefined,
    },
    sources: {
      host: host.source,
      port: port.source,
      security: security.source === "unset" ? port.source : security.source,
      from: from.source,
      fromName: fromName.source,
      user: user.source,
      password: password.source,
    },
  };
}

// --------------------------------------------------------------- for the page

/**
 * What `GET /admin/config` returns: every effective value, where it came from,
 * and whether the secrets are set — never the secrets themselves. The page can
 * therefore show the operator exactly what will be used without ever learning
 * the token or the password.
 */
export function describeConfig(env: FioEnvSource & SmtpEnvSource, row: AppConfigRow) {
  const fio = resolveFio(env, row);
  const host = pickOptional(row.smtpHost, env.SMTP_HOST);
  const port = pickNumber(row.smtpPort, env.SMTP_PORT, DEFAULT_SMTP_PORT);
  const security = pickOptional(row.smtpSecure, env.SMTP_SECURE);
  const from = pickOptional(row.smtpFrom, env.SMTP_FROM);
  const fromName = pickOptional(row.smtpFromName, env.SMTP_FROM_NAME);
  const user = pickOptional(row.smtpUser, env.SMTP_USER);
  const password = pickOptional(row.smtpPassword, env.SMTP_PASSWORD);

  return {
    fio: {
      enabled: fio.enabled,
      enabledSource: fio.sources.enabled,
      pollIntervalSeconds: fio.intervalSeconds,
      pollIntervalSource: fio.sources.intervalSeconds,
      apiBase: fio.apiBase,
      apiBaseSource: fio.sources.apiBase,
      unmatchedTtlDays: fio.unmatchedTtlDays,
      unmatchedTtlDaysSource: fio.sources.unmatchedTtlDays,
      tokenSet: fio.token !== null,
      tokenSource: fio.sources.token,
    },
    smtp: {
      host: host.value ?? "",
      hostSource: host.source,
      port: port.value,
      portSource: port.source,
      security: security.value ?? "",
      securitySource: security.source === "unset" ? port.source : security.source,
      from: from.value ?? "",
      fromSource: from.source,
      fromName: fromName.value ?? "",
      fromNameSource: fromName.source,
      userSet: user.value !== null,
      userSource: user.source,
      passwordSet: password.value !== null,
      passwordSource: password.source,
    },
  };
}

// ------------------------------------------------------------ saving the page

export type ConfigPatchResult = { ok: true; patch: Record<string, string | number | null> } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(input: unknown): string {
  return typeof input === "string" ? input.trim() : typeof input === "number" ? String(input) : "";
}

/**
 * Turns the config page's form into a row patch, or explains why it can't.
 *
 * Two different meanings for "empty", and the difference matters:
 *
 * - **Non-secret fields**: empty means *clear the override*, so that field goes
 *   back to its environment value. That is what an operator clearing a box
 *   expects, and the page shows them the resulting value immediately.
 * - **Secret fields**: empty means *leave it alone*. The page is never sent the
 *   stored token or password, so it cannot echo them back — if empty meant
 *   clear, merely saving the form would wipe the credentials.
 *
 * Validated here rather than at send time because `fulfilOrder` swallows
 * configuration errors into each order's `lastError`: a bad setting would
 * quietly break delivery instead of announcing itself.
 */
export function buildConfigPatch(
  input: Record<string, unknown>,
  env: FioEnvSource & SmtpEnvSource,
  row: AppConfigRow,
): ConfigPatchResult {
  const patch: Record<string, string | number | null> = {};

  // --- Fio
  if (typeof input.fioEnabled !== "boolean") return { ok: false, error: "fioEnabled must be true or false" };
  patch.fioEnabled = input.fioEnabled ? 1 : 0;

  const interval = text(input.fioPollIntervalSeconds);
  if (interval === "") {
    patch.fioPollIntervalSeconds = null;
  } else {
    const parsed = Number(interval);
    if (!Number.isInteger(parsed) || parsed < MIN_POLL_INTERVAL_SECONDS) {
      return { ok: false, error: `fioPollIntervalSeconds must be a whole number of at least ${MIN_POLL_INTERVAL_SECONDS}` };
    }
    patch.fioPollIntervalSeconds = parsed;
  }

  const token = text(input.fioToken);
  if (token !== "") patch.fioToken = token;

  const ttl = text(input.unmatchedPaymentTtlDays);
  if (ttl === "") {
    patch.unmatchedPaymentTtlDays = null;
  } else {
    const parsed = Number(ttl);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      return { ok: false, error: "unmatchedPaymentTtlDays must be a whole number of days between 1 and 365" };
    }
    patch.unmatchedPaymentTtlDays = parsed;
  }

  // --- SMTP
  for (const field of ["smtpHost", "smtpFrom", "smtpFromName"] as const) {
    const value = text(input[field]);
    patch[field] = value === "" ? null : value;
  }

  const from = patch.smtpFrom;
  if (typeof from === "string" && !EMAIL_RE.test(from)) {
    return { ok: false, error: "smtpFrom must look like an e-mail address" };
  }

  const port = text(input.smtpPort);
  if (port === "") {
    patch.smtpPort = null;
  } else {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { ok: false, error: "smtpPort must be a whole number between 1 and 65535" };
    }
    patch.smtpPort = parsed;
  }

  const security = text(input.smtpSecure);
  patch.smtpSecure = security === "" ? null : security.toLowerCase();

  for (const field of ["smtpUser", "smtpPassword"] as const) {
    const value = text(input[field]);
    if (value !== "") patch[field] = value;
  }

  // The port and the security mode have to be checked *together*, and against
  // what they will actually be once this patch is applied — a form that only
  // changes the port must still not be able to leave the pair contradictory.
  const portNow = typeof patch.smtpPort === "number" ? patch.smtpPort : pickNumber(row.smtpPort, env.SMTP_PORT, DEFAULT_SMTP_PORT).value;
  const securityNow =
    typeof patch.smtpSecure === "string" ? patch.smtpSecure : pickOptional(row.smtpSecure, env.SMTP_SECURE).value;
  try {
    parseSecurity(securityNow, portNow);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (securityNow === "none") {
    const hostNow = typeof patch.smtpHost === "string" ? patch.smtpHost : pickOptional(row.smtpHost, env.SMTP_HOST).value;
    if (hostNow && !isLoopbackHost(hostNow)) {
      return { ok: false, error: "unencrypted SMTP (none) is only allowed for a local test server" };
    }
  }

  return { ok: true, patch };
}
