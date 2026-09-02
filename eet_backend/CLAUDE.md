# eet-backend — agent handoff notes

This file is for whoever (human or agent) picks this project up next. See
[README.md](README.md) for the API reference, setup steps, and the
Exclusive C14N gotchas — this file is about *state*: what's actually done,
what's verified, and what's still open.

## What this is, in one paragraph

A standalone Cloudflare Worker (not yet deployed — no domain/route
configured, see wrangler.jsonc) that signs and submits sales to the Czech
EET 2.0 electronic sales registration system, with its own D1-backed retry
queue, plus a Fio Banka poll that auto-registers every incoming bank
transfer with EET on its own. Started as a filesystem copy of the `eet`
Worker built for the stena-letnak climbing-wall app (same signing/retry
core, D1 schema `0001_init.sql`, HTTP API) — the source repo at
`/home/jirik/stena-letnak/eet` is untouched by this copy. The Fio poll
(`src/lib/fio.ts`, migration `0002_fio_state.sql`) is new here and was
ported from stena-letnak's own `src/lib/fio.ts`, simplified: this Worker has
no `PaymentOrder` table to match transactions against, so it reports every
positive-amount transaction as-is rather than only "unmatched" ones — see
README's "Fio Banka polling" section for the full reasoning and the
double-reporting trade-off that implies if a consuming app also calls
`/report` itself for the same transfers.

## Current status

- **Not deployed anywhere yet**, but the D1 database itself now exists —
  `wrangler.jsonc`'s `d1_databases[0].database_id` was updated from the
  original placeholder to a real id from `wrangler d1 create eet-backend-db`
  (and `"remote": true` was added, so `wrangler dev` talks to that real
  remote D1 unless `--local` is passed explicitly — worth knowing when
  smoke-testing locally, see below). No `routes`/custom domain configured
  yet; add one once this project has an actual domain, or just deploy to the
  default `*.workers.dev` URL.
- **Typechecks clean** (`npx tsc --noEmit`) and **migrations apply cleanly
  locally** (`npx wrangler d1 migrations apply eet-backend-db --local`,
  verified for both `0001_init.sql` and `0002_fio_state.sql`).
- **`/report` verified end-to-end against the real EET playground**
  (`pg.trzbyeet.gov.cz`) via `wrangler dev` — got a real POK back (`-ff`
  suffix, `test: true`), using the same playground `CZ00000019`
  certificate/key already sitting in `.dev.vars` (copied from the source
  repo — see "Getting the playground test certificate" in README if these
  ever need regenerating).
- **The Fio poll's actual network call to `fioapi.fio.cz` is *not* verified
  in this environment** — outbound requests to that host hang indefinitely
  here (sandbox network policy, not application code; other endpoints stay
  responsive while a poll request is in flight, confirming it's specifically
  the outbound `fetch()` that's blocked). What *is* verified: `FIO_TOKEN`
  loads correctly from `.dev.vars` into `env`, `GET /fio/status` reads
  `FioState` correctly, `POST /fio/poll` returns the documented
  `FIO_NOT_CONFIGURED` error when the token is unset, and `scheduled()`
  doesn't crash when the Fio poll throws (wrapped in its own try/catch so a
  Fio-side failure can't block the separate PENDING-EET-row retry loop).
  Confirm the actual Fio fetch path works once deployed with real network
  access and a real token — the code is a close port of stena-letnak's own
  `fio.ts`, which is understood to work in that project's real deployment.
- **No secrets are set on any deployed Worker** — there's no deployed Worker
  yet. `.dev.vars` (gitignored) has local-only values: `EET_API_TOKEN=dev-local-token`,
  the playground cert/key, `FIO_TOKEN=` (empty — Fio poll is a no-op
  locally until a real token is set), and `ADMIN_PASSWORD=dev-local-admin-password`.
- **`GET /admin` is now a real login-gated dashboard, not just a static
  notice** (`src/lib/adminPage.ts`) — password field authenticates against
  a new `ADMIN_PASSWORD` secret (separate from `EET_API_TOKEN`, see
  `checkAdminAuth` in `index.ts`), token kept in that browser's
  `localStorage` and sent as a normal `Authorization` header, shows Fio poll
  state + a filterable `EetSale` table + a "check now" button wired to
  `POST /fio/poll`. Verified end-to-end in this environment: wrong password
  rejected, correct `ADMIN_PASSWORD` logs in, correct `EET_API_TOKEN` also
  works (both are valid for `/admin/data`, `/fio/status`, `/fio/poll` —
  *not* for `/report`/`/status/:reference`, which stay `EET_API_TOKEN`-only,
  see `checkAuth` vs `checkAdminAuth`), a row created via `/report` shows up
  after clicking "Obnovit", session survives a page reload, logout clears
  it. No constant-time comparison on the password check — consistent with
  the existing `checkAuth`'s plain `===`, not treated as a gap worth its own
  complexity for a single-operator admin page.
- **`src/index.ts`'s `attemptSubmit`/`normalizeAmount`/find-or-insert logic
  was extracted into `src/lib/reportSale.ts`** (`reportSale(env, reference,
  amountCzk)`) so both `POST /report` and the Fio poll share the exact same
  idempotent behavior — this is the one structural change beyond adding Fio
  support; `attemptSubmit`'s retry-everything-until-48h semantics are
  unchanged from the source repo (see its own docstring in
  `reportSale.ts`).
- **Cron changed from `*/5 * * * *` to `* * * * *`** (every minute — the
  finest granularity Cloudflare allows) so the Fio poll can run close to its
  configured `FIO_POLL_INTERVAL_SECONDS` (30s floor, 60s default) rather
  than being capped at 5 minutes; `scheduled()` still only actually retries
  a `PENDING` EET row or fetches Fio when there's something due, so this
  doesn't change how often EET itself gets hit for rows with nothing new to
  retry.

## Known gaps / next steps

Carried over from the source repo (still true, code unchanged) unless noted:

1. **`errorMessage` is inconsistent on `/report`'s pending responses** — a
   freshly failed attempt only returns `errorCode`, not `errorMessage`, even
   though `reportSale.ts`'s `attemptSubmit` already has it. Only
   `/status/:reference` (or an `EXPIRED`/legacy `REJECTED` reply) includes
   it.
2. **Response signature isn't verified** — `eetClient.ts` only
   regex-extracts `pok`/`test`/`kod`/error text and trusts TLS, never checks
   the tax authority's own signature on the response (interface spec §5.3).
3. **`dat_prij`, `uuid_zpravy` (response header), and `<Varovani>` aren't
   parsed or surfaced anywhere.**
4. **No automated tests** — everything here (including the new Fio poll
   plumbing) was verified manually; see "Current status" above for exactly
   what was and wasn't exercised.
5. **Cron retry batch is capped at 20 `PENDING` rows per run** — unrelated
   to the Fio poll (which has its own separate per-poll transaction loop,
   uncapped since Fio's own bookmark already bounds it to "new since last
   call").
6. **New, specific to the Fio poll:** if this Worker ever ends up behind a
   consuming app that *also* calls `/report` for the same bank transfers
   (order-matched, like stena-letnak's own Fio poll does), the two need to
   agree on exactly one of them reporting each transaction — see README's
   "Fio Banka polling" section. As of this writing nothing consumes this
   Worker yet, so the question hasn't come up in practice.

## Before ever pointing this at production

None of the following exist yet — all still playground-only (same caveats
as the source repo):

- A **real production certificate**, obtained via DIS+/MOJE daně once EET
  2.0 is actually in force as law.
- The real `id_jednotky`/`id_pokl` values for whichever registered
  unit/till this ends up representing, replacing the placeholder
  `"1"`/`"POKLADNA1"`.
- The real production SOAP endpoint URL (not confirmed as part of either
  this or the source repo's research — check eet.gov.cz's developer portal).
- Confirmation from an accountant on which revenue streams are actually in
  scope for EET.
- A real Fio Banka API token (Nastavení účtu → Přístupy → API), and a
  decision on whether this Worker's own blanket "report every credit" Fio
  poll is the right model for whatever business ends up using it, versus
  wiring it up behind an app with its own order-matching first (see gap #6
  above).

Swap `EET_ENDPOINT`, `EET_EIC`, `EET_CERT_PEM`, and `EET_PRIVATE_KEY_PEM`
together as one unit when that day comes — never one at a time.
