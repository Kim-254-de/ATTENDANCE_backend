#pragma once
// Host stand-in for the Arduino core, just enough for src/main.cpp and src/api.cpp.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

class String {
public:
    String() = default;
    String(const char* s) : s_(s ? s : "") {}
    String(const std::string& s) : s_(s) {}
    String(char c) : s_(1, c) {}
    String(int v) : s_(std::to_string(v)) {}
    String(unsigned v) : s_(std::to_string(v)) {}
    String(long v) : s_(std::to_string(v)) {}
    String(unsigned long v) : s_(std::to_string(v)) {}

    const char* c_str() const { return s_.c_str(); }
    unsigned int length() const { return static_cast<unsigned int>(s_.size()); }
    bool isEmpty() const { return s_.empty(); }
    String substring(unsigned from) const { return from >= s_.size() ? String() : String(s_.substr(from)); }
    String substring(unsigned from, unsigned to) const { return from >= s_.size() ? String() : String(s_.substr(from, to > from ? to - from : 0)); }
    bool startsWith(const String& p) const { return s_.rfind(p.s_, 0) == 0; }
    bool endsWith(const String& p) const { return s_.size() >= p.s_.size() && s_.compare(s_.size() - p.s_.size(), p.s_.size(), p.s_) == 0; }
    void remove(unsigned index, unsigned count = 1) { if (index < s_.size()) s_.erase(index, count); }
    bool concat(const char* s) { s_ += s; return true; }
    bool concat(const char* s, unsigned n) { s_.append(s, n); return true; }
    bool concat(char c) { s_ += c; return true; }
    bool concat(const String& s) { s_ += s.s_; return true; }
    void reserve(unsigned n) { s_.reserve(n); }
    char operator[](unsigned i) const { return s_[i]; }

    String& operator+=(const String& o) { s_ += o.s_; return *this; }
    String& operator+=(const char* o) { s_ += o; return *this; }
    String& operator+=(char c) { s_ += c; return *this; }
    friend String operator+(const String& a, const String& b) { return String(a.s_ + b.s_); }
    friend String operator+(const String& a, const char* b) { return String(a.s_ + b); }
    friend String operator+(const char* a, const String& b) { return String(std::string(a) + b.s_); }
    friend String operator+(const String& a, int b) { return String(a.s_ + std::to_string(b)); }
    bool operator==(const String& o) const { return s_ == o.s_; }
    bool operator==(const char* o) const { return s_ == o; }
    bool operator!=(const String& o) const { return s_ != o.s_; }
    bool operator!=(const char* o) const { return s_ != o; }

private:
    std::string s_;
};

#define HIGH 1
#define LOW 0
#define INPUT_PULLUP 2
#define OUTPUT 1

unsigned long millis();
void delay(unsigned long ms);
void pinMode(int, int);
int digitalRead(int pin);
void tone(int pin, unsigned frequency, unsigned long duration);
int analogReadMilliVolts(int pin);

struct HostSerial {
    void begin(unsigned long) {}
    template <typename T> void print(const T&) {}
    template <typename T> void println(const T&) {}
};
extern HostSerial Serial;
