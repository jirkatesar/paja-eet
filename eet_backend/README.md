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

This project started as a copy of the `eet` Worker built for the
stena-letnak climbing-wall app (same signing/retry core); the Fio poll is
new here and is *not* tied to stena-letnak's own payment-matching logic — it
reports every incoming credit on its own, keyed by Fio's transaction id.

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
     `xmlsign.ts`, wrong `EET_EIC`, or a multi-day outage).
4. `GET /status/:reference` — look up the current state of a report.

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
   failure, is never double-registered. Outgoing/debit transactions
   (negative amount) are skipped.
3. Actually polling Fio is throttled to at most once every
   `FIO_POLL_INTERVAL_SECONDS` (30s floor, 60s default if unset/invalid) —
   state lives in the single-row `FioState` D1 table (`migrations/0002_fio_state.sql`).

**This Worker has no concept of "which order was this payment for"** — that
requires a consuming app matching by variable symbol against its own orders
(see stena-letnak's own Fio poll, `src/lib/fio.ts` in that repo, which does
exactly that before falling back to reporting only *unmatched* credits).
Here, every incoming credit is real revenue and gets reported as-is. If this
Worker is ever wired up behind an app that *also* calls `POST /report`
itself for the same bank transfer (e.g. on order confirmation), make sure
only one side reports each transaction — reporting the same money twice
under two different references would double-count it with EET.

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

## API

`POST /report` and `GET /status/:reference` require `Authorization: Bearer
<EET_API_TOKEN>`. `GET /admin/data`, `GET /fio/status`, and `POST /fio/poll`
accept either `EET_API_TOKEN` or `ADMIN_PASSWORD` — see "Admin dashboard"
below.

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
| `410 { reference, status: "expired", pok: null, test: false, errorCode, errorMessage }` | Still unregistered 48h after the sale (ZoET's offline-mode deadline) — cron gave up, needs manual follow-up |
| `409 { reference, status: "rejected", pok: null, test: false, errorCode, errorMessage? }` | Legacy only — a row written before this policy; new code never produces this |

**`GET /status/:reference`** → full row (`status`, `pok`, `test`,
`attempts`, `lastErrorCode`, `lastErrorMessage`, timestamps), or `404`.

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
