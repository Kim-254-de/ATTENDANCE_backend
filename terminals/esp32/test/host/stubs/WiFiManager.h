#pragma once
#include <cstdlib>
#include <string>
// Wi-Fi is the host's own network. The setup portal's server address is what
// someone would type there: SIM_API_URL when set, else the default.
class WiFiManagerParameter {
public:
    WiFiManagerParameter(const char*, const char*, const char* value, int) : value_(std::getenv("SIM_API_URL") ? std::getenv("SIM_API_URL") : value) {}
    const char* getValue() const { return value_.c_str(); }
private:
    std::string value_;
};
class WiFiManager {
public:
    void addParameter(WiFiManagerParameter*) {}
    void setConfigPortalTimeout(int) {}
    bool autoConnect(const char*) { return true; }
    bool startConfigPortal(const char*) { return true; }
};
