#pragma once
// Hardware-free terminal logic, unit-tested on the build machine (test/test_core).
#include <string>

namespace core {

enum class ScanKind { Link, Pairing, Barcode, Unknown };

struct Scan {
    ScanKind kind;
    std::string text; // trimmed; upper-cased for pairing codes and barcodes
};

// What a scanned code is for: the lecturer's class link code, the department's
// pairing code (only before pairing), or a student ID card barcode.
Scan classify(const std::string& raw, bool paired);

// Whether a refusal is the "already recorded" 409 (a retry that landed, or a
// student scanning twice), which the terminal shows as success.
bool isAlreadyRecorded(int status, const std::string& message);

// Battery percentage from the divider voltage at the ADC pin (millivolts),
// for a single Li-ion cell: 3.3 V empty, 4.2 V full. -1 when nothing is connected.
int batteryPercent(int pinMillivolts);

// The NVS key a fingerprint enrolment's slot is stored under. NVS keys are at
// most 15 characters, so this is "f" + the first 14 hex digits of the id.
std::string slotKey(const std::string& fingerprintId);

} // namespace core
