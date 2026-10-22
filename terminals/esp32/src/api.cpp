#include "api.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "root_ca.h"

namespace {

ApiResult send(const String& method, const String& baseUrl, const String& key, const String& path, const String* body) {
    ApiResult result;
    if (WiFi.status() != WL_CONNECTED) {
        result.networkError = true;
        result.message = "No Wi-Fi";
        return result;
    }

    String url = baseUrl;
    while (url.endsWith("/")) url.remove(url.length() - 1);
    url += "/" + path;

    WiFiClientSecure secure;
    WiFiClient plain;
    const bool https = url.startsWith("https://");
    if (https) secure.setCACert(ROOT_CA_BUNDLE);

    HTTPClient http;
    // The backend host sleeps when idle; the first call after can take a while.
    http.setTimeout(30000);
    if (!(https ? http.begin(secure, url) : http.begin(plain, url))) {
        result.networkError = true;
        result.message = "Bad server address";
        return result;
    }
    http.addHeader("Accept", "application/json");
    if (key.length()) http.addHeader("X-Terminal-Key", key);

    int status;
    if (method == "POST") {
        http.addHeader("Content-Type", "application/json");
        status = http.POST(body ? *body : String("{}"));
    } else {
        status = http.GET();
    }
    if (status <= 0) {
        result.networkError = true;
        result.message = HTTPClient::errorToString(status);
        http.end();
        return result;
    }

    result.status = status;
    JsonDocument doc;
    const DeserializationError parsed = deserializeJson(doc, http.getString());
    http.end();

    if (!parsed && doc["success"].as<bool>()) {
        result.ok = true;
        result.data.set(doc["data"]);
        return result;
    }
    result.code = parsed ? String("") : doc["error"]["code"].as<String>();
    result.message = parsed ? String("Unreadable answer (HTTP ") + status + ")" : doc["error"]["message"].as<String>();
    return result;
}

} // namespace

namespace api {

ApiResult post(const String& baseUrl, const String& key, const String& path, const JsonDocument& body) {
    // An empty document serializes as `null`, which the server rejects as a body; send `{}`.
    String text = "{}";
    if (!body.isNull()) {
        text = "";
        serializeJson(body, text);
    }
    return send("POST", baseUrl, key, path, &text);
}

ApiResult get(const String& baseUrl, const String& key, const String& path) {
    return send("GET", baseUrl, key, path, nullptr);
}

} // namespace api
