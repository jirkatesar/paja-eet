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
ported from stena-letnak's own `src/lib/fio.ts`, simplified: there is no
`PaymentOrder` table to match transactions against, so every positive-amount
transaction is reported as-is rather than only "unmatched" ones — see README's
"Fio Banka polling" section for the full reasoning and the double-reporting
trade-off that implies if a consuming app also calls `/report` itself for the
same transfers.

Since 2026-09-14 it also issues gift vouchers end to end: `POST /voucher`
renders one, and `POST /voucher/order` (migration `0003_voucher_order.sql`)
takes an order, matches the incoming bank transfer, and e-mails the voucher —
see "Voucher orders" in Current status and the README.

## Deployment is manual

**Do not deploy anything.** The Worker goes out with `npx wrangler deploy` and
the Android app is installed by hand — both by the person who owns this, on
purpose. They want to see the build output themselves, and nothing should reach
production as a side effect of some other piece of work.

What is expected instead: make the change, `npx tsc --noEmit`, build the APK and
run its tests, exercise the Worker against the local stubs, then say what is
ready and stop there.

Two consequences worth remembering:

- **Migrations are theirs to run too.** `wrangler d1 migrations apply … --remote`
  touches production data, and several migrations here have to land *before* the
  code that needs them (`0005` renamed a table, `0006` added one) — say so
  clearly rather than running it.
- **Reading production is fine.** `wrangler d1 execute … --remote` for a
  read-only query is how the state of a real problem gets diagnosed; just do not
  write, and never export or delete without being asked.

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
- **Fio and SMTP settings are editable from the browser** (`src/lib/appConfig.ts`,
  `adminConfigPage.ts`, migration `0004_app_config.sql`, added 2026-09-14). The
  page at `GET /admin/config` writes a single `AppConfig` row, and **a stored
  value overrides the environment; anything unset falls back to it**, so a
  deployment that never opens the page behaves exactly as before. Each field
  shows which of the two is winning, and one button clears every override.
  - **Secrets are write-only.** The Fio token and SMTP password are stored (in
    plain text — a deliberate trade against `wrangler secret`, which cannot be
    read back) but never returned: the API reports only `tokenSet`/`passwordSet`,
    and an empty field means "leave it alone". Verified for both GET and POST.
  - **Validated on save**, because `fulfilOrder` swallows configuration errors
    into per-order `lastError` — a bad setting would quietly break delivery
    rather than announce itself. The port/security pairing is checked against
    the *effective* values, so a form changing only the port cannot leave a
    contradictory pair behind (verified: 587 from the form + `tls` from ENV →
    400). Fio's 30s floor, the port range, the `From` shape and the
    no-plaintext-to-a-real-host rule are all enforced there too.
  - **Verified end to end**: a token stored on the page is the one the poll
    actually sends (a stub received `/last/tajny-fio-token/…` while the
    environment held a different one), reset put it back on the environment
    value, and a voucher order was delivered using SMTP settings that existed
    only in the config (the environment had no host at all).
  - Admin pages are assembled by `adminShell` (`src/lib/adminShared.ts`) so the
    login gate, styles and the **menu between /admin and /admin/config** exist
    once. That matters because the menu navigates with plain links, and the
    session only survives that reload because the token is kept in
    `localStorage` and re-validated on load — two copies of that logic would
    eventually log the operator out on a page switch.
  - `VOUCHER_KS`, `VOUCHER_ORDER_TTL_DAYS` and the EET settings are deliberately
    *not* on the page; the table is shaped so they can be added the same way.
- **`GET /admin` shows voucher orders too** — a second table fed by
  `GET /admin/orders` (status filter + limit), alongside the Fio poll state
  and the `EetSale` table below.
- **`GET /admin` is a real login-gated dashboard, not just a static
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
  configured `FIO_POLL_INTERVAL_SECONDS` (30s floor, 45s default) rather
  than being capped at 5 minutes; `scheduled()` still only actually retries
  a `PENDING` EET row or fetches Fio when there's something due, so this
  doesn't change how often EET itself gets hit for rows with nothing new to
  retry.
- **`POST /voucher` renders filled gift vouchers** (`src/lib/voucher.ts`,
  added 2026-09-14). `{ amountCzk, voucherNumber }` in, an
  `application/pdf` attachment out — the blank template
  (`assets/poukazka.pdf`, bundled as a Data module) with the amount, the
  number, and "Platnost do" drawn into the three blanks it already has. The
  date is always computed: today in **Europe/Prague** + 6 months, clamping to
  month end. Bearer auth is `EET_API_TOKEN`, same as `/report` — this is
  meant to be called by the Android app (`android_app/`, a sibling checkout),
  which already has a "poukázky" category and a `voucherNumber` field it puts
  in the payment's variable symbol; the app does *not* call it yet.
  Verified locally end-to-end through `wrangler dev`: real PDFs rendered and
  eyeballed for 3-, 4-, 5-, and 6-digit amounts and an 11-character number,
  the date logic unit-checked against month-end and leap-year cases, and
  `401`/`400` paths plus a `Content-Disposition` header-injection attempt
  (sanitized) exercised. **Not** verified on a deployed Worker.
  - Coordinates for the three blanks are hardcoded in `voucher.ts`, derived
    from the template's own glyph metrics — they are *not* computed at
    runtime. **Re-measure them if `assets/poukazka.pdf` is ever regenerated**
    or the values will land in the wrong place.
  - Values are drawn in Times-Roman (a base-14 font, nothing embedded): its
    metrics are identical to the template's Liberation Serif for every
    character drawn here, so the text lines up exactly. If the template ever
    uses a different face, that assumption dies with it.
  - The blank voucher itself came from `poukazka-original.pdf` (kept in the
    repo root, not bundled) by removing the three values from the content
    stream while compensating their width with a negative `TJ` kern, so
    nothing around them shifted.
- **Only payments that settle an order reach EET, and an order is made even
  without an e-mail** (migration `0006_unmatched_payment.sql`, added
  2026-09-15). This narrows what the Worker files: the Fio poll used to
  register *every* CZK credit, and now matches first and registers only what
  belongs to an order. A credit that matches nothing is kept in
  `UnmatchedPayment` — not filed — and dropped after
  `unmatchedPaymentTtlDays` (configurable on the web config page, default 30).
  - **Why the storage is not optional:** Fio moves its bookmark on every
    successful poll, so a payment fetched before its order existed is never
    shown again. `POST /order` therefore looks in `UnmatchedPayment` when it
    creates a transfer order, and if the money is already there it settles the
    order, registers the payment under `fio-<idPohyb>` and reports `PAID`.
  - **An empty e-mail is allowed** on `/order` (it used to be a 400): the order
    is what the payment is matched against, so it is worth having regardless.
    Nothing is sent when there is no address. The app no longer skips the call
    for a blank field.
  - Verified locally against stubs: a payment with no order was stored and
    **not** registered; an order created afterwards with an empty e-mail
    claimed it, was reported `PAID`, and the payment was registered at that
    moment; the waiting row was removed.
  - **Not verified:** the Android side (no emulator) and anything on a deployed
    Worker. Note that the app must be updated for its half — an older build
    still skips the order when the e-mail is blank.
- **Orders now cover services too, and every settlement sends a receipt**
  (`src/lib/paymentOrder.ts` renamed from `voucherOrder.ts`, `src/lib/receipt.ts`,
  migration `0005_payment_order.sql`, added 2026-09-14). A massage paid by
  transfer had nothing to match against — no variable symbol — so the app now
  **generates one** (`domain/PaymentReference.kt`, `MMddHHmmss`, tested) and the
  QR carries it. The table was renamed `VoucherOrder` → `PaymentOrder` and gained
  `kind` (`VOUCHER` | `SERVICE`).
  - **`POST /order`** is the endpoint; **`/voucher/order` stays as an alias** and
    `kind` defaults to `VOUCHER`, so the app already on the phone keeps working
    if the Worker is deployed first.
  - **What is sent**: one e-mail per order — the receipt, with the voucher PDF
    attached when `kind` is VOUCHER. Deliberately not two e-mails: the retry loop
    only knows sent/not-sent, so a failing receipt would resend the voucher on
    every attempt.
  - **The receipt is a stand-in** and says so in the message
    ("TESTOVACÍ účet, nejde o daňový doklad"). A document that looks like an
    invoice but isn't one is worse than none. Replace it once an accountant has
    said what a real one needs; nothing around it depends on the wording.
  - **Empty e-mail = no order at all.** The app only calls when an address was
    given, so with the field blank nothing is recorded and nothing is sent. The
    Worker still requires an address on any order it receives.
  - Matching is by variable symbol; the constant symbol is compared when the
    order has one, and skipped when it does not (a cash order never reaches
    matching, so that is only a caller which did not send one). Verified
    end to end: a SERVICE order settled by a matching transfer and the receipt
    went out; a cash service sent its receipt immediately; a cash voucher sent
    the PDF *and* the receipt; and `/voucher/order` without `kind` still behaves
    as a voucher.
- **`POST /voucher/order` takes voucher orders and delivers them**
  (`src/lib/voucherOrder.ts`, migration `0003_voucher_order.sql`, added
  2026-09-14). `{ amountCzk, variableSymbol, email, cash?, constantSymbol? }`
  in; the order is created, and the voucher is generated and **e-mailed** to
  the customer either immediately (`cash: true`, paid at the counter) or as
  soon as the Fio poll matches the incoming transfer on **VS + amount + KS**.
  The variable symbol *is* the voucher number, and a partial unique index keeps
  it unique among live orders — verified against real SQLite, including that
  expiring an order frees the symbol for reuse.
  - **Mail goes over `cloudflare:sockets`** (`src/lib/smtp.ts`) — Workers have
    no usable mail library, `nodemailer` needs node `net`/`tls`. This is
    hand-rolled SMTP: EHLO, AUTH PLAIN/LOGIN, MAIL FROM/RCPT TO/DATA, MIME
    `multipart/mixed` with a base64 PDF, dot-stuffing, RFC 2047 subject.
  - **Use port 465** (`SMTP_SECURE=tls`). Workerd has an open bug with
    `startTls()` on 587 (workerd#2712) that hangs some providers — though it
    did **not** reproduce against smtp.seznam.cz, which works on both ports.
  - **Certificate validation is enforced** by the runtime, verified rather than
    assumed: against a self-signed cert the client completed the TLS handshake
    and then sent *nothing* (the server logged no SMTP data at all), whereas
    against a valid cert it carried on to AUTH. So a bad certificate fails
    closed.
  - **`SMTP_SECURE=none` is refused for any non-loopback host** (checked in
    `sendMail` before a connection is opened), so a misconfiguration cannot put
    the mailbox password, or a customer's voucher, on the wire in clear.
    Verified all three ways: remote host refused in ~0.1s, loopback stub still
    works, and `tls` is unaffected by the guard.
  - Verified locally end to end: cash order → PDF generated → SMTP stub
    received a correct MIME message whose attachment renders as the right
    voucher; transfer order → matched by the Fio poll (including from a
    `0001`-style symbol against a stored `1`), unmatched/underpaid/wrong-KS
    cases logged without settling; a replayed poll neither re-matched nor
    re-sent; delivery failure left the order `PAID` with `lastError` and the
    next cron delivered it; unpaid orders expired and released their symbol;
    `/admin/orders` filters and auth.
  - Against **real infrastructure**, the SMTP transport reached
    `smtp.seznam.cz` on both 465 and 587 — TCP, TLS, greeting, EHLO and the
    AUTH command all worked, failing only on deliberately wrong credentials
    (`535 … incorrect credentials`) in ~1.3s.
  - **Not verified: a real mailbox actually receiving a voucher.** The sandbox
    has no SMTP credentials, so the final hop is untested. Same caveat as the
    Fio poll's real network call.
  - `FIO_API_BASE` exists so the matching can be driven from a stub; the real
    `fioapi.fio.cz` is unreachable here.

## Review pass (2026-09-14)

A full read-through of `src/` fixed seven things; all verified locally with
`wrangler dev --local --test-scheduled` against the local D1 and the real
playground endpoint (test rows deleted afterwards, local `FioState`
reset — the local DB is back to just the one pre-existing
`admin-ui-test-1` row):

1. **The Fio poll's throttle never engaged.** `runFioPollIfDue` read
   `lastRunAt` through a D1-format date parser, but wrote it as
   `Date.toISOString()` — the parser appended a second `Z`, `new Date()`
   returned `NaN`, and `NaN < interval` is `false`, so every run polled
   regardless of `FIO_POLL_INTERVAL_SECONDS`. `sqliteDatetimeMs` now lives
   once in `db.ts` and accepts both formats. Verified both ways: with a
   fresh `lastRunAt` the cron skips Fio entirely (51ms, no Fio call); with
   one 2 minutes old it attempts the fetch.
2. **`FIO_POLL_INTERVAL_SECONDS` default lowered 60 → 45** (and the
   `wrangler.jsonc` var with it). Now that the throttle works, a value ≥ the
   60s cron tick would skip roughly every other tick to jitter.
3. **Neither outbound `fetch` had a timeout** — a hung EET endpoint held
   `/report` (and the whole cron batch behind it) open, and per the note
   below the Fio endpoint hangs indefinitely in this sandbox. Both now use
   `AbortSignal.timeout` (10s EET, 15s Fio); verified — the Fio call aborts
   at 15.09s, records `lastError`, and the cron still returns 200.
4. **`markAttemptFailed` could clobber a concurrent `SENT`.** It set
   `status = 'PENDING'` unconditionally, so a cron retry losing a race with
   a `/report` attempt that had just succeeded would re-open an
   already-registered sale. Now guarded with `AND status = 'PENDING'`.
5. **The 48h deadline was measured from `createdAt`, not the sale.** It's
   now a set-based `expireOverdue()` sweep on `dat_trzby`, run before the
   retry batch — so it no longer depends on the row making it into a batch
   (it couldn't, at scale), and a late-noticed Fio transfer doesn't get a
   fresh 48h. Verified on all four boundary cases: `datTrzby` old (in both
   the D1 and ISO-with-`Z` formats) → `EXPIRED` even with a fresh
   `createdAt`; `datTrzby` fresh → registered normally even with a 72h-old
   `createdAt` (the old code expired that one).
6. **The Fio poll ignored the currency.** It reported any positive amount as
   CZK; `column14` (`Měna`) is now checked and non-CZK transactions are
   skipped with a log line. `dat_trzby` for Fio transactions now comes from
   the bank's own `Datum` (column0) instead of "now" — note that column is
   epoch **milliseconds** in the JSON API, not the `"YYYY-MM-DD+HH:MM"`
   string the XML API uses. Transactions with no `ID pohybu` are skipped
   (they'd all have collapsed onto the single `fio-` reference row).
7. **An unexpected throw from `/report` escaped as Workers' bare 500 page**
   (e.g. `reportSale`'s `internal_error`); the handler is now wrapped and
   answers `500 {"error":"internal_error"}` like every other error path.

One caveat carried over: **the Fio transaction *parsing* still isn't
verified end-to-end** — the sandbox blocks `fioapi.fio.cz`, so the abort
above is the furthest the path has been exercised. The column mapping was
re-checked against the official "Struktura TransactionList" table
(column0=Datum, 1=Objem, 4=KS, 5=VS, 10=Název protiúčtu, 14=Měna,
16=Zpráva pro příjemce, 22=ID pohybu — the code's indices are correct), but
a real token on a deployed Worker is still the first true test of it.

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
   call"). The batch is ordered least-attempted-first (see `listPending`), so
   a backlog larger than one batch now round-robins instead of retrying the
   same 20 oldest rows until they expire — but the *cap* is still 20, so a
   genuinely huge backlog (thousands of rows) means proportionally slower
   retries for everyone in it.
6. **`POST /voucher` only *renders* a voucher** — it registers nothing and
   reserves no number; two callers can mint the same one. Use
   `POST /voucher/order` if the number should be reserved and the sale
   delivered (it enforces uniqueness). The blanks' coordinates are also
   hardcoded against one template file (see "Current status"), with no
   automated check that they still line up.
7. **Voucher orders are not registered with EET by the order flow itself.**
   The money still reaches EET through the ordinary per-credit Fio poll
   (`fio-<idPohyb>`), and cash voucher sales are the app's own business to
   `/report` as it always was — but nothing checks that the two actually
   happened, so a voucher can be delivered for a payment that then failed to
   register. Worth a look if vouchers turn out to be a large share of revenue.
8. **Nothing consumes `POST /voucher/order` yet.** The Android app has the
   voucher category, the `voucherNumber` field and the KS setting, but no
   customer e-mail field — that has to be added on the app side before the
   endpoint can be called for real, and the app must send the same KS it puts
   in the payment QR (or the Worker's `VOUCHER_KS` must match it).
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
