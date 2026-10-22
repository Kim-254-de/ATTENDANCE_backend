#pragma once
#include <map>
#include <string>
#include "Arduino.h"

// NVS, in memory for the run.
class Preferences {
public:
    bool begin(const char*, bool) { return true; }
    String getString(const char* k, const String& d = String()) { auto it = s_.find(k); return it == s_.end() ? d : String(it->second); }
    size_t putString(const char* k, const String& v) { s_[k] = v.c_str(); return v.length(); }
    int32_t getInt(const char* k, int32_t d = 0) { auto it = i_.find(k); return it == i_.end() ? d : it->second; }
    size_t putInt(const char* k, int32_t v) { i_[k] = v; return 4; }
    bool remove(const char* k) { return s_.erase(k) + i_.erase(k) > 0; }
    std::map<std::string, std::string> s_;
    std::map<std::string, int32_t> i_;
};
