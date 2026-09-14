# eet-backend

Cloudflare Worker that reports sales to the Czech "EET 2.0" electronic sales
registration system (Elektronická evidence tržeb), with retry-on-failure
backed by D1. Exposes a small token-authenticated HTTP API so other apps
don't need to know anything about SOAP, WS-Security, or XML-DSig — just POST
an amount and a reference (see `POST /report` below).

It can also watch a Fio Banka account directly: with `FIO_TOKEN` set, a
cron-driven poll picks up every new incoming bank transfer and registers it
with EET automatically, with no consuming app required — see "Fio Banka
polling" below.

It can also render gift vouchers: `POST /voucher` fills the blank voucher
template with an amount, a voucher number, and a computed validity date —
see "Gift vouchers" below.

And it can take *orders* for them: `POST /voucher/order` records a sale, then
matches the incoming bank transfer (or takes the cash sale as paid up front),
generates the voucher and e-mails it to the customer — see "Voucher orders and
delivery" below.

This project started as a copy of the `eet` Worker built for the
stena-letnak climbing-wall app (same signing/retry core); the Fio poll is
new here and is *not* tied to stena-letnak's own payment-matching logic — it
reports every incoming credit on its own, keyed by Fio's transaction id, and
settles voucher orders along the way.

**Status: verified against the official playground only.** EET 2.0 is not
yet in force as law (see the design discussion this repo grew out of) — do
not point `EET_ENDPOINT` at a production EET endpoint or use a real
certificate until that's actually needed and confirmed with an accountant
which revenue streams are even in scope.

## How it works

1. `POST /report` with `{ reference, amountCzk }` (bearer token auth).
   - New `reference` → inserts a row, immediately attempts registration.
   - Already `SENT` → returns the stored result (idempotent replay).
   - Already `EXPIRED` → returns 410, past the 48h deadline (see below).
   - Otherwise (still `PENDING`) → retries immediately.
2. On success: marks the row `SENT`, returns the POK (EET's confirmation
   code) and whether the server flagged it `test` (always true on the
   playground).
3. On failure — network/parse error, transient EET codes `-1..-999`, *or*
   a protocol-level rejection (bad schema/signature/EIC/size, codes 2–8) —
   the row simply **stays `PENDING`** and is retried by the cron (every
   minute), regardless of which kind of failure it was. The caller can't do
   anything useful with an immediate hard failure either way — it never
   blocks or rolls back the payment, just logs the attempt — so there's no
   early "give up now" response; `/report` only ever answers `200` or `202`
   on a fresh attempt. The one thing that *does* end automatic retry:
   - **Still unregistered 48h after the sale** → ZoET (the law, not the
     technical interface spec) requires offline-mode sales to reach EET
     within 48 hours of the sale itself. Once a row crosses that age, the
     cron stops retrying it and marks it `EXPIRED` — a silent infinite
     retry loop past the legal deadline isn't useful, and this is the
     point a human actually needs to look at `lastErrorMessage` (bug in
     `xmlsign.ts`, wrong `EET_EIC`, or a multi-day outage). The age is
     measured from `dat_trzby` — the sale itself — not from when the row
     was created, so a payment that only gets noticed late (the Fio poll
     running after an outage) does not get a fresh 48h from the moment it
     was finally seen. This sweep is independent of the retry batch below,
     so a row can never be starved out of expiring.
4. `GET /status/:reference` — look up the current state of a report.

Each cron run retries a batch of 20 `PENDING` rows, least-attempted first
rather than oldest first: during a long EET outage the queue can grow past
one batch, and an oldest-first batch would retry the same 20 rows every
minute while the rest waited behind them. Ordering by attempt count
round-robins through the whole queue instead (ties break on id, so rows are
still drained oldest-first within an equal-attempt cohort).

`REJECTED` still exists as a status value only for rows written before this
retry-everything policy — new code never produces it.

Retries reuse the *same* `porad_cis` (the row's own id), `dat_trzby`,
`eic_popl`, `id_jednotky`, `id_pokl`, and `celk_trzba` — this composite is
exactly what EET's own server uses to recognize "this is the same sale
being resubmitted" (see interface spec §4), so a resend can never double-book
a sale even if EET's own dedup were the only thing protecting against it.
Only `uuid_zpravy` (fresh per attempt, per spec) and `prvni_zaslani`
(`false` on every retry) change.

Since a protocol-level rejection (e.g. error `4`, invalid signature) is
retried unchanged every minute for up to 48h rather than given up on
immediately, a stuck bug can mean thousands of near-identical resubmissions
of the same broken message before it expires. The interface spec (§2.2.3) warns
that "errors [the EET system] may interpret as a potential cyberattack"
get no response at all — worth keeping in mind if `xmlsign.ts` ever ships a
bug that survives a deploy for a while; check `wrangler tail` / D1 for a
`REJECTED`-looking `lastErrorCode` sooner rather than waiting for `EXPIRED`.

## The signing implementation

`src/lib/xmlsign.ts` hand-builds the signed SOAP envelope (WS-Security +
XML-DSig, Exclusive C14N, RSA-SHA256, SHA-256 digest) as plain strings
rather than using a generic XML library — there is no maintained
XML-DSig/WS-Security library that runs in the Workers sandbox without
native code, and the message shape here is small and completely fixed, so a
hand-rolled canonical-by-construction serializer is actually simpler and
more auditable than pulling in a generic canonicalizer.

Two non-obvious Exclusive C14N rules that cost real debugging time and are
worth knowing before touching this file:

- **Empty elements are never self-closing in canonical form.** `<Foo/>`
  must canonicalize to `<Foo></Foo>` — using `/>` in the "canonical" string
  produces a byte-different (and therefore signature-invalid) result.
- **Namespace declarations are not hoisted to the top of the signed
  subtree.** Each `xmlns:` declaration appears at the *shallowest* element
  that actually uses that prefix, not on the subtree's root just because
  something inside needs it. E.g. `xmlns:v4` belongs on `<v4:Trzba>` (the
  first thing that uses it), not on `<soap:Body>`, even though Body is the
  signed element.

Both were caught by cross-checking the hand-built canonical form against
`xmlsec1`'s own (real, spec-compliant) canonicalization — see "Debugging
the signature" below if this ever breaks again.

## Setup

```bash
npm install
npx wrangler d1 create eet-backend-db   # first time only — paste the returned id into wrangler.jsonc's database_id
npx wrangler d1 migrations apply eet-backend-db --local   # or --remote
```

Secrets (never in `wrangler.jsonc`):

```bash
openssl rand -hex 32 | npx wrangler secret put EET_API_TOKEN
npx wrangler secret put EET_CERT_PEM         < path/to/cert.pem
npx wrangler secret put EET_PRIVATE_KEY_PEM  < path/to/key-pkcs8.pem
npx wrangler secret put FIO_TOKEN            # optional — enables the Fio poll, see below
npx wrangler secret put ADMIN_PASSWORD       # optional — enables login on GET /admin, see below
npx wrangler secret put SMTP_USER            # optional — enables voucher e-mails, see below
npx wrangler secret put SMTP_PASSWORD
```

Non-sensitive config lives in `wrangler.jsonc`'s `vars` block (EIC, till
IDs, endpoint, `FIO_POLL_INTERVAL_SECONDS`) — swap `EET_ENDPOINT`/`EET_EIC`/
cert/key together as a unit when moving from playground to production, never
individually.

### Getting the playground test certificate

Download `CAEET_Playground_2026_v1.zip` from
[eet.gov.cz](https://eet.gov.cz/pro-vyvojare/) (or directly:
`https://eet.gov.cz/files/CAEET_Playground_2026_v1.zip`). It contains three
`.p12` files (one per test identity — individual/legal entity/VAT group)
and a shared password in `password_pokladni_cert_playground.txt`. The
legal-entity one (`CZ00000019`) is what this project defaults to. Extract
with OpenSSL (the `.p12`'s cert bag uses legacy RC2-40, hence `-legacy`):

```bash
openssl pkcs12 -in CA_EET-Playground-CZ00000019.p12 -passin file:password_pokladni_cert_playground.txt \
  -legacy -clcerts -nokeys -out cert.pem
openssl pkcs12 -in CA_EET-Playground-CZ00000019.p12 -passin file:password_pokladni_cert_playground.txt \
  -legacy -nocerts -nodes -out key.pem
```

Then strip each down to just the `-----BEGIN...-----`/`-----END...-----`
block (openssl prepends `Bag Attributes` lines) before feeding to
`wrangler secret put`.

### Local dev

`.dev.vars` (gitignored) holds the same variables for `wrangler dev` — see
the secret names above; multi-line PEM values need embedded `\n` escapes in
that file's `KEY="...\n..."` form. Leave `FIO_TOKEN` empty to keep the Fio
poll disabled locally. `ADMIN_PASSWORD` already has a local placeholder
value so `GET /admin` is testable out of the box.

### Debugging the signature

If EET starts rejecting with error code `4` ("Invalid SOAP message
signature") after touching `xmlsign.ts`, don't guess — cross-check against
a real canonicalizer:

```bash
xmlsec1 verify \
  --id-attr:Id "http://schemas.xmlsoap.org/soap/envelope/:Body" \
  --id-attr:Id "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd:BinarySecurityToken" \
  --pubkey-cert-pem cert.pem \
  --store-references \
  envelope.xml
```

`--store-references` prints xmlsec1's own canonicalized form of the signed
Body right before it hashes it — diff that against what `xmlsign.ts`
produced to find the exact divergence.

## Fio Banka polling

With `FIO_TOKEN` set, `scheduled()` (the same every-minute cron that retries
`PENDING` EET rows) also calls `runFioPollIfDue` (`src/lib/fio.ts`):

1. Fetches new transactions from Fio's `/rest/last/<token>/transactions.json`
   endpoint. Fio tracks the "new since last call" bookmark server-side per
   token — this Worker doesn't persist a cursor of its own, and an empty
   result leaves the bookmark untouched, so polling on a fixed interval is
   always safe.
2. Every transaction with a positive amount (an incoming credit) is reported
   to EET via the same `reportSale()` logic `POST /report` uses, keyed by
   `fio-<idPohyb>` (Fio's own transaction id) as the reference — so a
   transaction already seen on a previous poll, or retried after a partial
   failure, is never double-registered. Three kinds of transaction are
   skipped instead, each with a `console.error` line:
   - outgoing/debit transactions (negative amount) — not revenue;
   - anything whose `Měna` (column14) isn't `CZK` — EET's `celk_trzba` is
     always koruna and there's no exchange rate here, so a foreign-currency
     credit is *not* reported at its face amount as if it were;
   - anything without an `ID pohybu` (column22) — there'd be no stable
     reference to key on, and every such transaction would collapse onto the
     same `fio-` row.
   Each reported credit also gets one `console.log` line naming the payer and
   variable symbol (Fio's `Název protiúčtu`/`VS`/`Zpráva pro příjemce`),
   which is the only place those ever surface — EET has nowhere to put them
   and only the reference is kept in D1.
   `dat_trzby` is taken from the bank's own posting date (`Datum`, column0)
   rather than "now", so the sale is registered at the time it actually
   happened — see the 48h deadline above.
3. Actually polling Fio is throttled to at most once every
   `FIO_POLL_INTERVAL_SECONDS` — state lives in the single-row `FioState` D1
   table (`migrations/0002_fio_state.sql`). The floor is 30s, which is Fio's
   own hard limit per token (exceeding it is answered with HTTP 409); the
   default is 45s, deliberately below the 60s cron tick, because the throttle
   compares against the *previous run* — an interval of 60s or more would
   lose roughly every other tick to cron jitter and silently halve the real
   poll rate. `POST /fio/poll` bypasses the throttle entirely.

The poll also **settles voucher orders** whose variable symbol, amount and
constant symbol all match the payment — that is what triggers the voucher PDF
and its e-mail. See "Voucher orders and delivery" above. An order match does not
change the EET side: the credit is still registered as revenue.

Every incoming CZK credit is revenue and gets reported as-is, whether or not it
settles an order. If this Worker is ever wired up behind an app that *also*
calls `POST /report` itself for the same bank transfer (e.g. on order
confirmation), make sure only one side reports each transaction — reporting the
same money twice under two different references would double-count it with EET.

For local testing, `FIO_API_BASE` overrides the Fio API root. Pointing it at a
stub is the only way to exercise order matching without real bank traffic — the
sandbox this was developed in can't reach `fioapi.fio.cz` at all.

`GET /fio/status` (Bearer auth: `EET_API_TOKEN` or `ADMIN_PASSWORD`) →
`{ enabled, lastRunAt, lastReportedCount, lastError, lastErrorAt, updatedAt }`
— `enabled` just reflects whether `FIO_TOKEN` is set, not whether a poll has
run yet.

`POST /fio/poll` (Bearer auth: `EET_API_TOKEN` or `ADMIN_PASSWORD`) — forces
an immediate poll, ignoring the `FIO_POLL_INTERVAL_SECONDS` throttle;
returns `{ ranNow, reportedCount }` or `502 { error: "FIO_NOT_CONFIGURED" }`
if `FIO_TOKEN` isn't set. This is what the `/admin` dashboard's "Zkontrolovat
Fio teď" button calls; also useful for verifying a deployment without
waiting for the next cron tick.

## Gift vouchers

**`POST /voucher`** (Bearer auth: `EET_API_TOKEN`, the same credential the
Android app sends to `/report`) → an `application/pdf` attachment: the
voucher template with the amount, the voucher number, and a validity date
filled in.

```json
{ "amountCzk": 1200, "voucherNumber": "250315" }
```

- **Valid until** is always computed, never passed: today in Europe/Prague
  plus 6 months, matching the template's own "Platnost poukazu je 6 měsíců
  od data vystavení". Month-end clamps rather than overflowing — a voucher
  issued on 31 August is valid until 28 (or 29) February.
- **The amount** is drawn right-aligned so it always touches the template's
  own ",-Kč". The blank in the title is four digits wide at 18pt; a larger
  amount is drawn proportionally smaller rather than allowed to run into the
  "HODNOTĚ" in front of it. Whole crowns are the intended use — haléře are
  rendered (with a Czech decimal comma) rather than silently dropped, but
  read oddly against that ",-Kč".
- **The number** is printed as given. It is conventionally the same number
  the app puts in the payment's variable symbol.
- Row `404`/`400` behaviour matches the rest of the API: `400
  {"error":"..."}` for a missing or non-positive `amountCzk`/empty
  `voucherNumber`, `401` without a token.

The template lives in `assets/poukazka.pdf` and is bundled into the Worker as
a binary Data module (`rules` in wrangler.jsonc — note the broad glob and
`fallback: true` both being load-bearing). It is the *blank* voucher: its
three values are blanks in its own text runs, so the endpoint draws into them
and the labels, layout, and artwork are untouched. `poukazka-original.pdf` in
the repo root is the filled-in specimen the blank was derived from, kept for
reference; it is not bundled.

`src/lib/voucher.ts` also exports the pieces separately —
`fillVoucher(params, template?)` (the template defaults to the bundled one,
so tests can pass bytes), `computeValidUntil(issuedOn?)`, `addMonths`, and
`pragueToday` — none of which need a Worker runtime.

## Voucher orders and delivery

Rendering a voucher is one thing; getting it to the customer is another. The
app sells a voucher, the customer pays, and somebody has to connect the two.
That is what an order does.

**`POST /voucher/order`** (Bearer auth: `EET_API_TOKEN` — the app's existing
credential) creates the order:

```json
{ "amountCzk": 1500, "variableSymbol": "260914", "email": "jan@example.com",
  "cash": false, "constantSymbol": "0308" }
```

```json
201 { "id": 1, "variableSymbol": "260914", "amountCzk": "1500.00",
      "constantSymbol": "308", "email": "jan@example.com",
      "paymentMethod": "TRANSFER", "status": "PENDING",
      "createdAt": "…", "paidAt": null, "sentAt": null, "lastError": null }
```

The **variable symbol is the voucher number** — that is what the customer's
payment carries and what gets printed on the PDF — so a symbol can only be used
by one live order (a database index enforces it, not a check-then-insert, so two
concurrent calls can't both win). `409 variable_symbol_already_used` otherwise.

**What happens next depends on `cash`:**

| | `cash: false` (default) — bank transfer | `cash: true` — paid at the counter |
|---|---|---|
| Created as | `PENDING` | `PAID` |
| Voucher sent | when the Fio poll matches the payment | immediately, in the same request |
| Typical reply | `201 … "status": "PENDING"` | `201 … "status": "SENT"` |
| `constantSymbol` | required (from the call, else `VOUCHER_KS`) | not used |

Cash orders are created `PAID` rather than `PENDING` on purpose: if the Worker
died between writing the row and sending the mail, a `PENDING` order would sit
waiting for a bank payment that is never coming, and expire. As `PAID` it lands
in the delivery retry queue instead.

**A failed delivery is not a failed request.** If the mail cannot be sent, the
order stays `PAID` with `lastError` set, the reply still says `201`, and the
every-minute cron keeps retrying until it goes out. The dashboard shows which
ones are stuck and why.

**Matching a transfer** happens in the Fio poll (`src/lib/fio.ts`), on the
normalized variable symbol, and then requires **all three** of the amount, the
symbol and the constant symbol to line up. Symbols are compared with leading
zeros stripped, because the bank hands back `0007` for a symbol recorded as `7`
— a naive string compare would mean that payment never matched. When a symbol
matches but the amount or KS does not, it is logged loudly (an underpayment is
exactly the case where the customer thinks they have paid and nobody would
otherwise notice) and the order stays `PENDING` until it expires.

Matching is **in addition to** the ordinary EET registration, not instead of it:
the credit is still registered under `fio-<idPohyb>` as always. The voucher is
delivery on top of the revenue record.

Unpaid orders expire after `VOUCHER_ORDER_TTL_DAYS` (default 30) and release
their variable symbol for reuse.

### SMTP configuration

Outgoing mail goes over `cloudflare:sockets`, because Workers have no usable
e-mail library — `nodemailer` needs node's `net`/`tls`, which workerd doesn't
provide (see `src/lib/smtp.ts`).

```bash
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASSWORD
```

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_FROM_NAME` live in
`wrangler.jsonc`'s `vars`. **Use port 465 with `SMTP_SECURE=tls`**: there is an
open workerd bug with `startTls()` on 587 (workerd#2712) that hangs some
providers. It did not reproduce against smtp.seznam.cz, which works on both, so
`SMTP_SECURE=starttls` is a supported fallback — just not the default.

`SMTP_FROM` should be on the same domain as the authenticated account. The
Worker is a *submission* client — it hands the message to your provider, which
relays and signs it — so SPF and DKIM line up as long as the two match. A `From:`
on an unrelated domain will be the one thing that lands these in spam.

The Worker needs no inbound mail setup and no DNS records of its own.

`SMTP_SECURE=none` (plaintext) exists only for pointing local runs at a stub on
the same machine, and `sendMail` **enforces** that: it refuses to open an
unencrypted connection to anything that isn't a loopback address, so a
misconfiguration cannot put the mailbox password — or a customer's voucher — on
the wire in the clear. There is deliberately no override flag.

## API

`POST /report`, `GET /status/:reference`, `POST /voucher`, and
`POST /voucher/order` require `Authorization: Bearer <EET_API_TOKEN>`.
`GET /admin/data`, `GET /admin/orders`, `GET /fio/status`, and
`POST /fio/poll` accept either `EET_API_TOKEN` or `ADMIN_PASSWORD` — see
"Admin dashboard" below.

**`POST /report`**
```json
{ "reference": "order-123", "amountCzk": 150 }
```
`reference` is the caller's own idempotency key (a consuming app might use
its own order id; the Fio poll uses `fio-<idPohyb>`, see below) —
resubmitting the same reference either replays the stored result or retries
immediately, never double-registers.

Every response — success, pending, or expired, whether freshly computed or
replaying a stored row — always includes `pok`, `test`, and `errorCode`
(null/false when not applicable), so callers don't need to branch on shape:

| Status | Meaning |
|---|---|
| `200 { reference, status: "sent", pok, test, errorCode: null }` | Registered — `test: true` on the playground |
| `202 { reference, status: "pending", pok: null, test: false, errorCode }` | Not registered yet (any failure reason) — queued for the every-minute cron retry, up to the 48h deadline |
| `410 { reference, status: "expired", pok: null, test: false, errorCode, errorMessage }` | Still unregistered 48h after `dat_trzby` (the sale; ZoET's offline-mode deadline) — cron gave up, needs manual follow-up |
| `409 { reference, status: "rejected", pok: null, test: false, errorCode, errorMessage? }` | Legacy only — a row written before this policy; new code never produces this |

**`GET /status/:reference`** → full row (`status`, `pok`, `test`,
`attempts`, `lastErrorCode`, `lastErrorMessage`, timestamps), or `404`.

## Web configuration

Most of what used to need a `wrangler.jsonc` edit and a redeploy can be set from
the browser instead. `GET /admin/config` is a settings page behind the same
login as the dashboard, with a menu to switch between the two.

**Stored values override the environment; anything unset falls back to it.** A
deployment that never opens the page behaves exactly as before, `wrangler
secret` and `wrangler.jsonc` stay the source of truth, and "Vrátit vše na
hodnoty z prostředí" clears every override at once. Each field says where its
effective value comes from, so it is never a guess which of the two is winning.

What can be set:

| | |
|---|---|
| **Fio poll** | on/off, check interval (minimum 30s — Fio's own limit), API token |
| **SMTP** | host, port, security, sender address and name, user, password |

Two things worth knowing:

- **Secrets are write-only.** The page never receives the stored Fio token or
  SMTP password — only whether they are set — so the fields start empty and
  staying empty means "leave it alone". Saving the form therefore cannot wipe a
  credential it was never shown, and a value that cannot be read back cannot
  leak through a shared screen or a browser's form history.
- **Storing them in D1 is a real trade.** `wrangler secret` values are encrypted
  and unreadable; a value in the database is plain text to anyone with database
  access, and the settings page is only as strong as the single shared
  `ADMIN_PASSWORD`. Leaving the secrets in `wrangler secret` and using the page
  for everything else is entirely reasonable.

`FIO_API_BASE` is deliberately *not* on the page — it exists to point local runs
at a stub, not to be operated in production.

**`GET /admin/config/data`** returns the effective values, their source, and
`tokenSet`/`passwordSet` — never the secrets. **`POST /admin/config/data`** saves
(validated: the port and security mode must agree, the interval must respect
Fio's floor, `SMTP_SECURE=none` is refused for anything but a loopback host) and
**`POST /admin/config/reset`** drops every override. All three take
`EET_API_TOKEN` or `ADMIN_PASSWORD`.

## Admin dashboard

`GET /admin` — a small dependency-free HTML/JS dashboard
(`src/lib/adminPage.ts`, no build step, no framework). The page itself is
public; a password prompt gates everything it shows. Enter `ADMIN_PASSWORD`
(set via `wrangler secret put ADMIN_PASSWORD` — see "Setup" above) and it's
kept in that browser's `localStorage`, sent as a normal `Authorization`
header to the JSON endpoints below — never in a URL, never logged
server-side. `EET_API_TOKEN` also works as the dashboard password (so
scripted checks don't need a separate credential), but the point of
`ADMIN_PASSWORD` is that a human never has to handle `EET_API_TOKEN` just to
look at this page.

The dashboard shows the Fio poll's own state (with a "check now" button that
calls `POST /fio/poll`) and a filterable table of `EetSale` rows.

**`GET /admin/data`** (Bearer auth: `EET_API_TOKEN` or `ADMIN_PASSWORD`) —
returns `{ rows: EetSaleRow[] }`, filtered and capped server-side via query
params so the caller controls exactly how much it pulls:

| Param | Values | Default |
| --- | --- | --- |
| `status` | `ALL` \| `PENDING` \| `SENT` \| `EXPIRED` \| `REJECTED` | `ALL` |
| `dateFrom` | `YYYY-MM-DD`, inclusive, matched against `date(createdAt)` | today (UTC) |
| `dateTo` | `YYYY-MM-DD`, inclusive | today (UTC) |
| `limit` | 1–500 | 50 |

The UTC-"today" default only matters if a caller omits `dateFrom`/`dateTo`
entirely — a caller in Europe/Prague should pass its own local "today"
explicitly, since the two only disagree in the hour or so around UTC
midnight otherwise.

See "Fio Banka polling" above for `GET /fio/status` and `POST /fio/poll`.
