#!/usr/bin/env bash
# Builds the firmware for this computer: test/host/esp32-sim
set -euo pipefail
F="$(cd "$(dirname "$0")/../.." && pwd)"
AJ="$F/.pio/libdeps/esp32/ArduinoJson/src"   # run `pio run -e esp32` once to fetch it
g++ -std=c++17 -O1 -Wall -Wno-unused-label \
  -DARDUINO=10819 -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 \
  -DARDUINOJSON_ENABLE_ARDUINO_PRINT=0 -DARDUINOJSON_ENABLE_PROGMEM=0 \
  -I"$F/test/host/stubs" -I"$F/include" -I"$F/lib/core/src" -I"$AJ" \
  "$F/src/main.cpp" "$F/src/api.cpp" "$F/lib/core/src/terminal_core.cpp" "$F/test/host/host.cpp" \
  -o "$F/test/host/esp32-sim"
echo "built $F/test/host/esp32-sim"
