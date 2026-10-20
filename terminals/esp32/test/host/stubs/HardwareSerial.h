#pragma once
#include <deque>
#include "Arduino.h"
#define SERIAL_8N1 0

// The scanner's UART: bytes the host driver queues come out of read().
class HardwareSerial {
public:
    explicit HardwareSerial(int port) { if (port == 1) scanner() = this; }
    static HardwareSerial*& scanner() { static HardwareSerial* s = nullptr; return s; }
    void begin(unsigned long, int = 0, int = 0, int = 0) {}
    int available() { return static_cast<int>(rx.size()); }
    int read() { if (rx.empty()) return -1; int c = static_cast<unsigned char>(rx.front()); rx.pop_front(); return c; }
    std::deque<char> rx;
};
