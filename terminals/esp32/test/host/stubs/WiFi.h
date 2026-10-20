#pragma once
#define WL_CONNECTED 3
struct HostWiFi { int status() { return WL_CONNECTED; } };
extern HostWiFi WiFi;
class WiFiClient {};
