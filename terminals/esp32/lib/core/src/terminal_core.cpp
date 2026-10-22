#include "terminal_core.h"

#include <algorithm>
#include <cctype>

namespace core {

namespace {

std::string trim(const std::string& s) {
    size_t start = 0, end = s.size();
    while (start < end && std::isspace(static_cast<unsigned char>(s[start]))) ++start;
    while (end > start && std::isspace(static_cast<unsigned char>(s[end - 1]))) --end;
    return s.substr(start, end - start);
}

std::string upper(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return s;
}

bool isPairingCode(const std::string& s) {
    // ABCDE-FGHJK or ABCDEFGHJK
    std::string compact;
    for (char c : s) if (c != '-') compact += c;
    if (compact.size() != 10 || (s.size() != 10 && !(s.size() == 11 && s[5] == '-'))) return false;
    return std::all_of(compact.begin(), compact.end(), [](unsigned char c) { return std::isalnum(c); });
}

bool isRegistrationNumber(const std::string& s) {
    // backend barcodeCheckInSchema: 3-64 chars, starts alphanumeric, then letters, digits, / . _ -
    if (s.size() < 3 || s.size() > 64 || !std::isalnum(static_cast<unsigned char>(s[0]))) return false;
    return std::all_of(s.begin(), s.end(), [](unsigned char c) {
        return std::isalnum(c) || c == '/' || c == '.' || c == '_' || c == '-';
    });
}

} // namespace

Scan classify(const std::string& raw, bool paired) {
    const std::string text = trim(raw);
    if (text.rfind("ATL1.", 0) == 0) return {ScanKind::Link, text};
    if (!paired && isPairingCode(text)) return {ScanKind::Pairing, upper(text)};
    if (paired && isRegistrationNumber(text)) return {ScanKind::Barcode, upper(text)};
    return {ScanKind::Unknown, text};
}

bool isAlreadyRecorded(int status, const std::string& message) {
    return status == 409 && upper(message).find("ALREADY RECORDED") != std::string::npos;
}

int batteryPercent(int pinMillivolts) {
    if (pinMillivolts < 500) return -1; // floating pin: no battery wired
    const int cell = pinMillivolts * 2;  // 100k/100k divider halves it
    const int pct = (cell - 3300) * 100 / (4200 - 3300);
    return std::max(0, std::min(100, pct));
}

std::string slotKey(const std::string& fingerprintId) {
    std::string hex;
    for (char c : fingerprintId) {
        if (c != '-') hex += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (hex.size() == 14) break;
    }
    return "f" + hex;
}

} // namespace core
