#pragma once
#include <string>
#include "Arduino.h"
#include "Wire.h"
#define SSD1306_SWITCHCAPVCC 0x2
#define SSD1306_WHITE 1

// The OLED, as a log: every display() prints what is on screen.
class Adafruit_SSD1306 {
public:
    Adafruit_SSD1306(int, int, TwoWire*, int) {}
    bool begin(int, int) { return true; }
    void clearDisplay() { lines_.clear(); }
    void setTextColor(int) {}
    void setTextSize(int) {}
    void setCursor(int, int) { lines_ += " | "; }
    void print(const String& s) { lines_ += s.c_str(); }
    void print(const char* s) { lines_ += s; }
    void display();
private:
    std::string lines_;
};
