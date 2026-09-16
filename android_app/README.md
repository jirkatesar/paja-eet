# Masáže

Android frontend (Kotlin + Jetpack Compose) for taking payments and reporting them to EET 2.0.

## Flow

1. Staff enters an amount, picks category (**masáž** / **poukázky**) and payment method (**hotovost** / **převodem**).
2. **Hotovost** — the app POSTs `{ reference, amountCzk }` to `EET_URL/report` with `Authorization: Bearer EET_TOKEN` and shows the returned FIK/POK (or a "queued"/error state with retry). Same contract as the `eet` Worker used by `stena-letnak`. The `reference` (a UUID) is generated once per transaction and reused on retry, so the Worker can dedupe instead of double-registering the sale.
2. **Převodem** — the app builds a Czech "Short Payment Descriptor" (SPD) payload from the configured bank account/bank code and the KS for the selected category, renders it as a QR code, and lets staff share it (as an image, for banking-app QR import) or copy the raw payment string. The QR carries a variable symbol — the voucher number for a voucher, a generated one (`PaymentReference`) for a service — and the app records the order at the Worker (`POST /order`), so the incoming transfer can be matched and the receipt (plus the voucher PDF) e-mailed. Registering the sale with EET once the transfer lands is the Worker's own job; the app never reports a transfer itself.

## The menu

| | |
|---|---|
| **Platba** | the till: amount, category, e-mail, method, submit |
| **Nezaplacené** | orders the Worker is holding that nobody has paid for yet (`GET /orders`) |
| **Neodeslané** | sales this phone could not tell the Worker about, with a retry button |
| **Nastavení** | EET address and token, bank account, both KS, presets, retry interval |

The two lists are different kinds of wrong and are not interchangeable:
*Nezaplacené* is an order the Worker knows about whose money never arrived, and
after `VOUCHER_ORDER_TTL_DAYS` it expires and its variable symbol goes back into
circulation. A payment that arrived but did not match — the wrong amount, or the
wrong constant symbol — says so on the card, because that is the case where the
customer believes they have paid. *Neodeslané* is this phone failing to reach
the Worker at all; nothing there is even known to the backend, and a cash sale
in that state is a legal record with a 48-hour deadline.

*Nezaplacené* is fetched when the screen is opened and when its refresh button is
pressed — it is deliberately not polled, so the payment screen never waits on a
network call, and the menu shows no count for it (a number that is only right
when somebody last looked is worse than none).

## Configuration (Nastavení screen)

Stored locally on-device via Jetpack DataStore (app-private storage, not encrypted):

- `EET_URL`, `EET_TOKEN` — the EET reporting Worker's endpoint + bearer token.
- Bank account number + bank code (e.g. `123456-789/0800` or just `789/0800`).
- KS for service payments, KS for voucher payments.

## Building

Requires JDK 17 and the Android SDK (compileSdk 34, build-tools 34.0.0). Open in Android Studio, or from the CLI:

```bash
./gradlew assembleDebug
```

Point `local.properties` → `sdk.dir` at your Android SDK if Android Studio hasn't already generated it for you.

## Tests

```bash
./gradlew test
```

Covers the IBAN/mod-97 checksum and SPD payload builder in [`CzechBankQr`](app/src/main/java/cz/paja/eet/domain/CzechBankQr.kt) against known reference vectors, and the wire-format readers in [`UnpaidOrders`](app/src/main/java/cz/paja/eet/data/UnpaidOrders.kt) — the Worker's decimal amount string and its UTC `"2026-09-15 12:34:56"` timestamps, which would otherwise shift every date by the Prague offset.

## Verifying the look

`Theme.kt` holds the whole palette, the type scale and the corner radii; the
colours are the green the vouchers are printed in, and dynamic colour is off so
that stays true on Android 12+ instead of being replaced by the wallpaper's.

**The screens have not been looked at by whoever last changed them.** The
intent was to render them without an emulator using AGP's Compose preview
screenshot testing (`com.android.compose.screenshot`), which is what
`./gradlew updateDebugScreenshotTest` is for — but the plugin is still alpha and
discovered none of the previews in this setup, so it was removed again rather
than left in the build pretending to work. Everything below therefore rests on
reading the source, and wants a pair of eyes on a real device:

- the payment form: amount, category, voucher number, e-mail, method, submit
- the QR screen: amount, code, symbols, and the order card under it
- the unpaid list: one card per order (amount, VS, e-mail, dates, the expiry
  line) and the mismatch warning on the one that needs chasing — **never seen
  with real rows in it**, since that needs a Worker that has some
- both in **light and dark** — dark is the one worth checking, since that is
  where the QR's white surface matters
- the settings screen's four sections

Worth knowing when looking: the app is deliberately not dynamic-coloured, so
changing the wallpaper must not change anything.
