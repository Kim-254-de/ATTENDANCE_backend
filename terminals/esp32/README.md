# Attendance Terminal (ESP32, Option B)

Firmware for the self-built box ([`docs/hardware-specs.md`](../../docs/hardware-specs.md) Option B),
following the backend contract in [`docs/terminals.md`](../../docs/terminals.md). Same behaviour as the
Android app: pair, report in, link to a class, check in by ID card barcode or
fingerprint, carry out enrolment and removal the department queued.

The R503 holds **200 fingerprints**, so one box covers one large class, not a
whole department's pool (see the spec's comparison table). Use it as the cheap
prototype.

## Parts

| Part | Notes |
|---|---|
| ESP32 DevKit (esp32dev) | Wi-Fi |
| GROW R503 fingerprint module | 3.3 V, UART 57600 |
| GM65 barcode/QR module | UART 9600, set to serial output |
| SSD1306 128x64 OLED, I2C | address 0x3C |
| Piezo buzzer | |
| 1-cell Li-ion + charger + 100k/100k divider to GPIO34 | optional; battery shows as unknown without it |

## Wiring

| ESP32 | To |
|---|---|
| GPIO16 (RX2) | R503 TX |
| GPIO17 (TX2) | R503 RX |
| GPIO25 | GM65 TX |
| GPIO26 | GM65 RX |
| GPIO21 / GPIO22 | OLED SDA / SCL |
| GPIO27 | Buzzer + |
| GPIO34 | Battery divider midpoint |
| GPIO0 (BOOT button) | Short press: unlink class. Hold 5 s: Wi-Fi setup |

Pins are in `include/config.h`.

## Build and flash

```bash
pip install platformio            # or use the VS Code PlatformIO extension
pio test -e native                # unit tests for the logic in lib/core, on this computer
pio run -e esp32 -t upload        # build and flash over USB
pio device monitor
```

## First start

1. The box opens a Wi-Fi network **AttendanceTerminal**. Join it from a phone, pick
   the campus Wi-Fi, and check the server address (defaults to the production API).
2. On the department's Terminals page, add the device and scan its pairing QR code
   with the box's scanner.
3. In class, the lecturer taps **Link a terminal**; scan that code.

## HTTPS

Certificates are checked against the roots in `include/root_ca.h` (ISRG Root X1
and YR, GTS Root R1/R4, GlobalSign Root CA), which cover Railway, Render,
Cloudflare and other Let's Encrypt or Google Trust Services hosts.
Add the root of any other host you point a box at.

## Not built

- 4G backup (needs a SIM7600-class modem and TinyGSM); Wi-Fi only for now.
- NFC cards (the university's cards are barcode).
