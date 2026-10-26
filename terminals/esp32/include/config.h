#pragma once

// Wiring. Change here if your board is wired differently (README "Wiring").
#define PIN_FINGER_RX 16  // ESP32 RX  <- R503 TX (yellow)
#define PIN_FINGER_TX 17  // ESP32 TX  -> R503 RX (green)
#define PIN_SCANNER_RX 25 // ESP32 RX  <- GM65 TX
#define PIN_SCANNER_TX 26 // ESP32 TX  -> GM65 RX
#define PIN_BUZZER 27
#define PIN_BUTTON 0      // BOOT button: short press unlinks, hold 5 s for Wi-Fi setup
#define PIN_BATTERY 34    // battery through a 100k/100k divider; leave unconnected on USB power
#define OLED_ADDRESS 0x3C

// Behaviour.
#define DEFAULT_API_URL "https://attendance.nextup.co.ke/api/v1"
#define HEARTBEAT_MS 60000UL
#define FINGER_CAPACITY 200 // R503 template slots
#define FIRMWARE_VERSION "esp32-1.0.0"
