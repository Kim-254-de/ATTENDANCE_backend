#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

// One answer from the backend. The server wraps everything as
// { success, data } or { success: false, error: { code, message } }.
struct ApiResult {
    bool ok = false;
    bool networkError = false; // no answer at all: Wi-Fi down, timeout, TLS failure
    int status = 0;
    String code;
    String message;
    JsonDocument data;
};

// The terminal's calls (backend docs/terminals.md). Base URL and key are
// passed in on every call so pairing and Wi-Fi setup take effect at once.
namespace api {
ApiResult post(const String& baseUrl, const String& key, const String& path, const JsonDocument& body);
ApiResult get(const String& baseUrl, const String& key, const String& path);
}
