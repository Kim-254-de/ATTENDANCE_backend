// Runs the real firmware (src/main.cpp, src/api.cpp) on this computer against
// a real backend. Hardware is simulated; commands on stdin drive it:
//   scan <text>     the GM65 reads <text> (and loop() runs once)
//   finger <x>      a finger is pressed: a slot number, "new" (being enrolled) or "stranger"
//   loop <n>        run loop() n times
//   advance <ms>    move the clock forward (e.g. past the heartbeat interval)
//   button <ms>     hold the BOOT button for <ms>
//   slots           print the sensor's stored slots
// Each command is answered with "OK"; screen, buzzer and HTTP calls are logged.
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

#include <iostream>
#include <sstream>

#include "Adafruit_Fingerprint.h"
#include "Adafruit_SSD1306.h"
#include "Arduino.h"
#include "HTTPClient.h"
#include "HardwareSerial.h"
#include "WiFi.h"
#include "Wire.h"

void setup();
void loop();

HostSerial Serial;
TwoWire Wire;
HostWiFi WiFi;

namespace {
unsigned long clockMs = 1000;
unsigned long buttonReleaseAt = 0;
std::string lastScreen;
}

unsigned long millis() { return clockMs; }
void delay(unsigned long ms) { clockMs += ms; }
void pinMode(int, int) {}
int digitalRead(int) { return clockMs < buttonReleaseAt ? LOW : HIGH; }
void tone(int, unsigned frequency, unsigned long) { std::cout << "BEEP " << (frequency > 1000 ? "good" : "bad") << std::endl; }
int analogReadMilliVolts(int) { return 1980; } // ~73% on a 1-cell divider

void Adafruit_SSD1306::display() {
    if (lines_ != lastScreen) std::cout << "SCREEN" << lines_ << std::endl;
    lastScreen = lines_;
}

bool HTTPClient::begin(WiFiClient&, const String& url) {
    std::string u = url.c_str();
    if (u.rfind("http://", 0) != 0) return false;
    u = u.substr(7);
    const auto slash = u.find('/');
    std::string hostPort = u.substr(0, slash);
    path_ = slash == std::string::npos ? "/" : u.substr(slash);
    const auto colon = hostPort.find(':');
    host_ = hostPort.substr(0, colon);
    port_ = colon == std::string::npos ? 80 : std::stoi(hostPort.substr(colon + 1));
    headers_.clear();
    return true;
}

int HTTPClient::send(const std::string& method, const std::string& body) {
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host_.c_str(), std::to_string(port_).c_str(), &hints, &res) != 0) return -1;
    const int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd < 0 || connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
        freeaddrinfo(res);
        if (fd >= 0) close(fd);
        return -1;
    }
    freeaddrinfo(res);

    std::ostringstream req;
    req << method << " " << path_ << " HTTP/1.1\r\nHost: " << host_ << ":" << port_ << "\r\nConnection: close\r\nUser-Agent: esp32-host-sim\r\n";
    for (const auto& h : headers_) req << h << "\r\n";
    if (method == "POST") req << "Content-Length: " << body.size() << "\r\n";
    req << "\r\n" << body;
    const std::string out = req.str();

    for (size_t sent = 0; sent < out.size();) {
        const ssize_t n = ::send(fd, out.data() + sent, out.size() - sent, 0);
        if (n <= 0) { close(fd); return -1; }
        sent += static_cast<size_t>(n);
    }

    std::string raw;
    char buf[4096];
    ssize_t n;
    while ((n = recv(fd, buf, sizeof buf, 0)) > 0) raw.append(buf, static_cast<size_t>(n));
    close(fd);

    const auto headerEnd = raw.find("\r\n\r\n");
    if (headerEnd == std::string::npos) return -1;
    const int status = std::stoi(raw.substr(9, 3));
    std::string head = raw.substr(0, headerEnd);
    body_ = raw.substr(headerEnd + 4);
    if (head.find("chunked") != std::string::npos) { // de-chunk
        std::string plain;
        size_t pos = 0;
        while (true) {
            const auto eol = body_.find("\r\n", pos);
            const size_t size = std::stoul(body_.substr(pos, eol - pos), nullptr, 16);
            if (size == 0) break;
            plain += body_.substr(eol + 2, size);
            pos = eol + 2 + size + 2;
        }
        body_ = plain;
    }
    std::cout << "HTTP " << method << " " << path_ << " -> " << status << std::endl;
    return status;
}

int main() {
    std::cout.setf(std::ios::unitbuf);
    setup();
    std::cout << "OK" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::string cmd, arg;
        in >> cmd;
        std::getline(in >> std::ws, arg);
        if (cmd == "scan") {
            for (char c : arg) HardwareSerial::scanner()->rx.push_back(c);
            HardwareSerial::scanner()->rx.push_back('\r');
            loop();
        } else if (cmd == "finger") {
            Adafruit_Fingerprint::instance()->presses.push_back(arg);
        } else if (cmd == "loop") {
            for (int i = 0, n = arg.empty() ? 1 : std::stoi(arg); i < n; ++i) loop();
        } else if (cmd == "advance") {
            clockMs += std::stoul(arg);
        } else if (cmd == "button") {
            buttonReleaseAt = clockMs + std::stoul(arg);
            loop();
        } else if (cmd == "slots") {
            std::cout << "SLOTS";
            for (int s : Adafruit_Fingerprint::instance()->slots) std::cout << " " << s;
            std::cout << std::endl;
        } else if (cmd == "quit") {
            break;
        }
        std::cout << "OK" << std::endl;
    }
}
