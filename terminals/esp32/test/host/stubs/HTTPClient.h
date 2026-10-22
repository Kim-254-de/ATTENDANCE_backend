#pragma once
#include <string>
#include <vector>
#include "Arduino.h"
#include "WiFi.h"

// A real HTTP/1.1 client over sockets, http:// only (the local backend).
class HTTPClient {
public:
    bool begin(WiFiClient&, const String& url);
    void setTimeout(int) {}
    void addHeader(const String& name, const String& value) { headers_.push_back(std::string(name.c_str()) + ": " + value.c_str()); }
    int GET() { return send("GET", ""); }
    int POST(const String& body) { return send("POST", body.c_str()); }
    String getString() { return String(body_); }
    void end() {}
    static String errorToString(int code) { return String("connection error ") + code; }
private:
    int send(const std::string& method, const std::string& body);
    std::string host_, path_;
    int port_ = 80;
    std::vector<std::string> headers_;
    std::string body_;
};
