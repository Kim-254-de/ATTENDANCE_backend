# Attendance Terminal (Android, Option A)

The app for the department's portable handhelds ([`docs/hardware-specs.md`](../../docs/hardware-specs.md)
Option A). It follows the backend contract in [`docs/terminals.md`](../../docs/terminals.md):

- **Pair** by scanning (or typing) the code from the department's Terminals page.
- **Report in** every minute: battery, Wi-Fi or mobile data, app version.
- **Link** to a class by scanning the code from the lecturer's "Link a terminal".
- **Check in** students by ID card barcode or fingerprint, for the linked class.
- **Enrol / remove fingerprints** the department queued, pausing check-ins meanwhile.
- If the department marks it lost, retires or re-pairs it, it forgets its key and
  shows the pairing screen. Fingerprint templates and the slot map stay, because the
  server files enrolments under the terminal's code, which survives re-pairing.

## Build

Needs JDK 17 and the Android SDK (platform 35, build-tools 35).

```bash
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
JAVA_HOME=~/Android/jdk/jdk-17.0.20.1+1 ./gradlew testDebugUnitTest assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

Unit tests (`app/src/test`) cover scan routing, the HTTP client against a mock
server, and the engine (pairing, linking, check-in retry rules, enrolment and
removal commands, being cut off) against a fake backend.

## Layout

| Path | What |
|---|---|
| `data/TerminalApi.kt` | HTTP client for `/terminals/*`, envelope parsing, `ApiException` |
| `data/TerminalStore.kt` | Server address, key and fingerprint slot map, encrypted with the Android Keystore |
| `domain/ScanRouter.kt` | Decides whether a scan is a pairing code, link code or student barcode |
| `domain/TerminalEngine.kt` | All behaviour; no Android dependencies |
| `hardware/FingerprintReader.kt` | Sensor interface + `SimulatedFingerprintReader` |
| `hardware/BarcodeInput.kt` | Keyboard-wedge input from built-in scanners |
| `ui/` | Activity, view model, Compose screens |

## Scanners

- **Built-in scanner, keyboard mode** (most handhelds' default): works as-is; reads end with Enter.
- **Built-in scanner, broadcast mode**: enter the vendor's broadcast action and data extra on the setup screen.
- **No scanner**: "Scan with camera" uses Google's code scanner (needs Google Play services).

## Adding a vendor fingerprint SDK

Until the handheld model is chosen the app uses `SimulatedFingerprintReader`: on
screen you type a "slot" and press the finger button. For a real device:

1. Add the vendor's SDK (`.aar`) under `app/libs` and to `app/build.gradle.kts`.
2. Implement `FingerprintReader`:
   - `identify()`: capture, 1:N search against the templates the app stores, return `Match(slot)` or `NoMatch`.
   - `enrol()`: capture the finger (usually 2-3 presses), store the template under a new slot id, return `Stored(slot)`.
   - `delete(slot)`: remove that template.
   Store templates in app-private storage (or the sensor's own memory if it has one). Never send them anywhere.
3. Return it from `createFingerprintReader()` in `ui/TerminalViewModel.kt`.

## Not built yet

- NFC card reading (the university's cards are barcode; the server supports `cardUid` if NFC cards come later).
- Offline queuing: with no connection the terminal says so and records nothing, as the backend expects.
