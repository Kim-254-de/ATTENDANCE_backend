#pragma once
#include <deque>
#include <set>
#include <string>
#include "HardwareSerial.h"

#define FINGERPRINT_OK 0x00
#define FINGERPRINT_NOFINGER 0x02
#define FINGERPRINT_NOTFOUND 0x09
#define FINGERPRINT_BADLOCATION 0x0B

// A simulated R503. The host driver queues presses: a slot number for a finger
// that is stored there, "new" for a finger being enrolled, "stranger" for one
// nobody enrolled.
class Adafruit_Fingerprint {
public:
    explicit Adafruit_Fingerprint(HardwareSerial*) { instance() = this; }
    static Adafruit_Fingerprint*& instance() { static Adafruit_Fingerprint* f = nullptr; return f; }
    void begin(unsigned long) {}
    bool verifyPassword() { return true; }
    uint8_t getImage() {
        if (lifting) { lifting = false; return FINGERPRINT_NOFINGER; }
        if (presses.empty()) return FINGERPRINT_NOFINGER;
        lifting = true;
        current = presses.front();
        presses.pop_front();
        return FINGERPRINT_OK;
    }
    uint8_t image2Tz(uint8_t = 1) { return FINGERPRINT_OK; }
    uint8_t fingerSearch(uint8_t = 1) {
        try {
            int slot = std::stoi(current);
            if (slots.count(slot)) { fingerID = static_cast<uint16_t>(slot); return FINGERPRINT_OK; }
        } catch (...) {}
        return FINGERPRINT_NOTFOUND;
    }
    uint8_t createModel() { return FINGERPRINT_OK; }
    uint8_t storeModel(uint16_t id) { slots.insert(id); return FINGERPRINT_OK; }
    uint8_t loadModel(uint16_t id) { return slots.count(id) ? FINGERPRINT_OK : FINGERPRINT_BADLOCATION; }
    uint8_t deleteModel(uint16_t id) { slots.erase(id); return FINGERPRINT_OK; }

    uint16_t fingerID = 0;
    std::deque<std::string> presses;
    std::set<int> slots;
    std::string current;
    bool lifting = false;
};
