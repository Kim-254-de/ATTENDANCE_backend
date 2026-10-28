// Attendance terminal firmware, Option B: ESP32 + R503 + GM65 + SSD1306.
//
// Follows the backend's terminal contract (backend docs/terminals.md):
//   unpaired  -> scan the department's pairing code -> receives its own key
//   paired    -> reports in every minute, links to a class by scanning the
//                lecturer's code, records ID card barcodes and fingerprints
//   commands  -> enrols or removes fingerprints the department queued
// Fingerprints are matched on the R503 itself; only the slot number is sent.

#include <Adafruit_Fingerprint.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <Wire.h>

#include "api.h"
#include "config.h"
#include "terminal_core.h"

namespace {

HardwareSerial fingerSerial(2);
HardwareSerial scannerSerial(1);
Adafruit_Fingerprint finger(&fingerSerial);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Preferences prefs;

bool fingerOk = false;
String apiUrl;
String key;

struct Session {
    String id;
    String unitCode;
    bool acceptsBarcode = false;
    bool acceptsFinger = false;
} session;

String terminalCode;
bool online = false;
unsigned long lastBeat = 0;
unsigned long feedbackUntil = 0;

// --- Screen and buzzer -------------------------------------------------------

void show(const String& title, const String& line1 = "", const String& line2 = "", unsigned long holdMs = 0) {
    oled.clearDisplay();
    oled.setTextColor(SSD1306_WHITE);
    oled.setTextSize(1);
    oled.setCursor(0, 0);
    oled.print(terminalCode.length() ? terminalCode : String("Terminal"));
    oled.setCursor(92, 0);
    oled.print(online ? "online" : "OFFLN");
    oled.setTextSize(2);
    oled.setCursor(0, 14);
    oled.print(title.substring(0, 10));
    oled.setTextSize(1);
    oled.setCursor(0, 36);
    oled.print(line1.substring(0, 21));
    oled.setCursor(0, 48);
    oled.print(line2.substring(0, 21));
    oled.display();
    feedbackUntil = holdMs ? millis() + holdMs : 0;
}

void beep(bool good) {
    if (good) {
        tone(PIN_BUZZER, 2400, 120);
    } else {
        tone(PIN_BUZZER, 600, 450);
    }
}

void showIdle() {
    if (!key.length()) show("Pair me", "Scan pairing code", "from Terminals page");
    else if (!session.id.length()) show("No class", "Scan lecturer's", "class code");
    else show(session.unitCode, session.acceptsBarcode ? "Scan ID card" : "", session.acceptsFinger ? "or place finger" : "");
}

// --- Storage -------------------------------------------------------------------

void saveKey(const String& value) {
    key = value;
    prefs.putString("key", value);
}

// Cut off by the department (lost, retired, re-paired). Fingerprint templates
// and their slot map stay: the server files enrolments under this terminal's
// code, which survives re-pairing.
void unpair(const String& why) {
    saveKey("");
    session = Session{};
    show("Unpaired", why, "Scan pairing code", 4000);
    beep(false);
}

// --- Server ----------------------------------------------------------------------

void applySession(JsonVariantConst data) {
    if (data["terminal"]["code"].is<const char*>()) terminalCode = data["terminal"]["code"].as<String>();
    JsonVariantConst s = data["session"];
    if (s.isNull()) {
        session = Session{};
        return;
    }
    session.id = s["sessionId"].as<String>();
    session.unitCode = s["unitCode"].as<String>();
    session.acceptsBarcode = false;
    session.acceptsFinger = false;
    for (JsonVariantConst a : s["accepts"].as<JsonArrayConst>()) {
        if (a == "BARCODE") session.acceptsBarcode = true;
        if (a == "FINGERPRINT") session.acceptsFinger = true;
    }
}

// Any refusal: a 401 means this device's key is dead.
void refuse(const ApiResult& r) {
    if (r.status == 401 && key.length()) return unpair("Ask your department");
    if (r.networkError) online = false;
    show("Not done", r.message, r.message.length() > 21 ? r.message.substring(21) : String(""), 4000);
    beep(false);
}

void pair(const String& code) {
    JsonDocument body;
    body["pairingCode"] = code;
    ApiResult r = api::post(apiUrl, "", "terminals/pair", body);
    if (!r.ok) return refuse(r);
    saveKey(r.data["key"].as<String>());
    applySession(r.data);
    online = true;
    show("Paired", terminalCode, "Scan class code", 4000);
    beep(true);
}

void link(const String& code) {
    if (!key.length()) {
        show("Not paired", "Pair with your", "department first", 3000);
        return beep(false);
    }
    JsonDocument body;
    body["linkCode"] = code;
    ApiResult r = api::post(apiUrl, key, "terminals/link", body);
    if (!r.ok) return refuse(r);
    applySession(r.data);
    show("Linked", session.unitCode, "Ready", 3000);
    beep(true);
}

void unlink() {
    if (!session.id.length()) return;
    ApiResult r = api::post(apiUrl, key, "terminals/unlink", JsonDocument());
    if (!r.ok) return refuse(r);
    applySession(r.data);
    show("Unlinked", "", "", 2000);
    beep(true);
}

// One check-in. A network failure is retried once, and "already recorded" on
// the retry means the first attempt landed (backend card-check-in.md).
void checkIn(const char* field, const String& value) {
    if (!session.id.length()) {
        show("No class", "Scan lecturer's", "class code", 3000);
        return beep(false);
    }
    JsonDocument body;
    body[field] = value;
    bool retried = false;
    while (true) {
        ApiResult r = api::post(apiUrl, key, "terminals/check-in", body);
        if (r.ok) {
            online = true;
            show("Present", r.data["student"]["fullName"].as<String>(), r.data["student"]["registrationNumber"].as<String>(), 3000);
            return beep(true);
        }
        if (r.networkError && !retried) {
            retried = true;
            continue;
        }
        if (core::isAlreadyRecorded(r.status, r.message.c_str())) {
            show(retried ? "Present" : "Already in", "", "", 3000);
            return beep(true);
        }
        return refuse(r);
    }
}

// --- Fingerprint reader ------------------------------------------------------

// Returns the matched slot, 0 for a finger nobody matches, -1 when no finger is on the sensor.
int identify() {
    if (finger.getImage() != FINGERPRINT_OK) return -1;
    if (finger.image2Tz(1) != FINGERPRINT_OK) return 0;
    if (finger.fingerSearch() != FINGERPRINT_OK) return 0;
    return finger.fingerID;
}

bool waitFor(uint8_t wanted, unsigned long timeoutMs) {
    const unsigned long until = millis() + timeoutMs;
    while (millis() < until) {
        if (finger.getImage() == wanted) return true;
        delay(50);
    }
    return false;
}

int freeSlot() {
    for (int slot = 1; slot <= FINGER_CAPACITY; ++slot) {
        if (finger.loadModel(slot) != FINGERPRINT_OK) return slot;
    }
    return 0;
}

// Two presses of the same finger, merged into one template in a free slot.
// Returns the slot, or 0 with `why` set.
int enrol(const String& who, String& why) {
    const int slot = freeSlot();
    if (!slot) {
        why = "The reader is full";
        return 0;
    }
    for (uint8_t pass = 1; pass <= 2; ++pass) {
        show("Enrol", who, pass == 1 ? "Place finger" : "Same finger again");
        if (!waitFor(FINGERPRINT_OK, 20000)) {
            why = "No finger placed";
            return 0;
        }
        if (finger.image2Tz(pass) != FINGERPRINT_OK) {
            why = "Unclear fingerprint";
            return 0;
        }
        beep(true);
        show("Enrol", who, "Lift finger");
        waitFor(FINGERPRINT_NOFINGER, 10000);
    }
    if (finger.createModel() != FINGERPRINT_OK) {
        why = "The two presses did not match";
        return 0;
    }
    if (finger.storeModel(slot) != FINGERPRINT_OK) {
        why = "Could not store the fingerprint";
        return 0;
    }
    return slot;
}

void failCommand(const String& id, const String& reason) {
    JsonDocument body;
    body["reason"] = reason;
    api::post(apiUrl, key, "terminals/commands/" + id + "/fail", body);
    show("Not done", reason, "", 4000);
    beep(false);
}

// Enrolments and removals the department queued for this device.
void runCommands() {
    ApiResult list = api::get(apiUrl, key, "terminals/commands");
    if (!list.ok) return;
    for (JsonVariantConst c : list.data.as<JsonArrayConst>()) {
        const String id = c["id"].as<String>();
        const String kind = c["kind"].as<String>();
        const String who = c["student"]["fullName"] | c["student"]["registrationNumber"] | String("student");

        if (!fingerOk) {
            failCommand(id, "This terminal's fingerprint reader is not working");
            continue;
        }
        if (kind == "ENROL_FINGERPRINT") {
            String why;
            const int slot = enrol(who, why);
            if (!slot) {
                failCommand(id, why);
                continue;
            }
            JsonDocument body;
            body["fingerRef"] = String(slot);
            ApiResult done = api::post(apiUrl, key, "terminals/commands/" + id + "/complete", body);
            if (done.ok && done.data["fingerprintId"].is<const char*>()) {
                prefs.putInt(core::slotKey(done.data["fingerprintId"].as<const char*>()).c_str(), slot);
                show("Enrolled", who, "", 3000);
                beep(true);
            } else {
                finger.deleteModel(slot); // the server would not take it: no orphan template
                refuse(done);
            }
        } else if (kind == "DELETE_FINGERPRINT") {
            const String fingerprintId = c["fingerprintId"] | String("");
            const std::string slotKey = core::slotKey(fingerprintId.c_str());
            const int slot = prefs.getInt(slotKey.c_str(), 0);
            if (slot) finger.deleteModel(slot);
            ApiResult done = api::post(apiUrl, key, "terminals/commands/" + id + "/complete", JsonDocument());
            if (done.ok) prefs.remove(slotKey.c_str());
        } else {
            failCommand(id, "Firmware does not know " + kind);
        }
    }
}

void heartbeat() {
    lastBeat = millis();
    JsonDocument body;
    const int battery = core::batteryPercent(analogReadMilliVolts(PIN_BATTERY));
    if (battery >= 0) body["batteryPercent"] = battery;
    body["network"] = "WIFI";
    body["appVersion"] = FIRMWARE_VERSION;
    ApiResult r = api::post(apiUrl, key, "terminals/heartbeat", body);
    if (!r.ok) {
        if (r.status == 401) return unpair("Ask your department");
        online = !r.networkError;
        return;
    }
    online = true;
    applySession(r.data);
    if ((r.data["pendingCommands"] | 0) > 0) runCommands();
}

// --- Inputs ---------------------------------------------------------------------

// The GM65 sends a read as bytes with no reliable terminator; a 60 ms pause ends it.
String readScanner() {
    static String buffer;
    static unsigned long lastByte = 0;
    while (scannerSerial.available()) {
        const char c = static_cast<char>(scannerSerial.read());
        if (c == '\r' || c == '\n') {
            lastByte = 0;
            break;
        }
        buffer += c;
        lastByte = millis();
    }
    if (buffer.length() && (lastByte == 0 || millis() - lastByte > 60)) {
        String scan = buffer;
        buffer = "";
        return scan;
    }
    return "";
}

void onScan(const String& raw) {
    const core::Scan scan = core::classify(raw.c_str(), key.length() > 0);
    switch (scan.kind) {
        case core::ScanKind::Pairing: return pair(scan.text.c_str());
        case core::ScanKind::Link: return link(scan.text.c_str());
        case core::ScanKind::Barcode:
            if (!session.acceptsBarcode && session.id.length()) {
                show("Not done", "Class not taking", "ID cards", 3000);
                return beep(false);
            }
            return checkIn("barcode", scan.text.c_str());
        case core::ScanKind::Unknown:
            show("Unknown", "Not an ID card or", "class code", 3000);
            return beep(false);
    }
}

void startWifi(bool forcePortal) {
    WiFiManager wm;
    WiFiManagerParameter urlParam("api", "Server address", apiUrl.c_str(), 120);
    wm.addParameter(&urlParam);
    wm.setConfigPortalTimeout(300);
    show("Wi-Fi", forcePortal ? "Setup: join Wi-Fi" : "Connecting...", "AttendanceTerminal");
    const bool connected = forcePortal ? wm.startConfigPortal("AttendanceTerminal") : wm.autoConnect("AttendanceTerminal");
    if (strlen(urlParam.getValue()) && apiUrl != urlParam.getValue()) {
        apiUrl = urlParam.getValue();
        prefs.putString("url", apiUrl);
    }
    online = connected;
}

// Short press unlinks the class; hold 5 s to reopen Wi-Fi setup.
void handleButton() {
    if (digitalRead(PIN_BUTTON) == HIGH) return;
    const unsigned long pressed = millis();
    while (digitalRead(PIN_BUTTON) == LOW && millis() - pressed < 5000) delay(10);
    if (millis() - pressed >= 5000) startWifi(true);
    else if (millis() - pressed > 50) unlink();
}

} // namespace

void setup() {
    Serial.begin(115200);
    pinMode(PIN_BUTTON, INPUT_PULLUP);
    pinMode(PIN_BUZZER, OUTPUT);
    Wire.begin();
    oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);

    prefs.begin("terminal", false);
    apiUrl = prefs.getString("url", DEFAULT_API_URL);
    key = prefs.getString("key", "");

    fingerSerial.begin(57600, SERIAL_8N1, PIN_FINGER_RX, PIN_FINGER_TX);
    finger.begin(57600);
    fingerOk = finger.verifyPassword();
    scannerSerial.begin(9600, SERIAL_8N1, PIN_SCANNER_RX, PIN_SCANNER_TX);

    startWifi(false);
    if (!fingerOk) show("Warning", "Fingerprint reader", "not found", 3000);
    if (key.length()) heartbeat();
    showIdle();
}

void loop() {
    handleButton();

    const String scan = readScanner();
    if (scan.length()) onScan(scan);

    if (key.length() && millis() - lastBeat > HEARTBEAT_MS) heartbeat();

    if (fingerOk && key.length() && session.acceptsFinger) {
        const int slot = identify();
        if (slot > 0) checkIn("fingerRef", String(slot));
        else if (slot == 0) {
            show("Not known", "Fingerprint not", "enrolled here", 3000);
            beep(false);
        }
    }

    if (feedbackUntil && millis() > feedbackUntil) {
        feedbackUntil = 0;
        showIdle();
    } else if (!feedbackUntil) {
        static unsigned long lastIdle = 0;
        if (millis() - lastIdle > 1000) {
            lastIdle = millis();
            showIdle();
        }
    }
    delay(20);
}
