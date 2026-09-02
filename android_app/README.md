# Masáže

Android frontend (Kotlin + Jetpack Compose) for taking payments and reporting them to EET 2.0.

## Flow

1. Staff enters an amount, picks category (**masáž** / **poukázky**) and payment method (**hotovost** / **převodem**).
2. **Hotovost** — the app POSTs `{ reference, amountCzk }` to `EET_URL/report` with `Authorization: Bearer EET_TOKEN` and shows the returned FIK/POK (or a "queued"/error state with retry). Same contract as the `eet` Worker used by `stena-letnak`. The `reference` (a UUID) is generated once per transaction and reused on retry, so the Worker can dedupe instead of double-registering the sale.
2. **Převodem** — the app builds a Czech "Short Payment Descriptor" (SPD) payload from the configured bank account/bank code and the KS for the selected category, renders it as a QR code, and lets staff share it (as an image, for banking-app QR import) or copy the raw payment string. Registering the sale once the transfer lands is handled entirely by your existing backend — this app only produces the QR code.

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

Covers the IBAN/mod-97 checksum and SPD payload builder in [`CzechBankQr`](app/src/main/java/cz/paja/eet/domain/CzechBankQr.kt) against known reference vectors.
