#include <unity.h>

#include "terminal_core.h"

using core::ScanKind;

void setUp() {}
void tearDown() {}

void test_link_code_in_either_state() {
    TEST_ASSERT_TRUE(core::classify(" ATL1.abc.123.sig\r\n", true).kind == ScanKind::Link);
    TEST_ASSERT_TRUE(core::classify("ATL1.abc.123.sig", false).kind == ScanKind::Link);
    TEST_ASSERT_EQUAL_STRING("ATL1.abc.123.sig", core::classify("ATL1.abc.123.sig\n", true).text.c_str());
}

void test_pairing_code_only_before_pairing() {
    auto scan = core::classify("abcde-fghjk", false);
    TEST_ASSERT_TRUE(scan.kind == ScanKind::Pairing);
    TEST_ASSERT_EQUAL_STRING("ABCDE-FGHJK", scan.text.c_str());
    TEST_ASSERT_TRUE(core::classify("ABCDEFGHJK", false).kind == ScanKind::Pairing);
    TEST_ASSERT_TRUE(core::classify("ABCD-EFGHJK", false).kind == ScanKind::Unknown);
}

void test_barcode_once_paired() {
    auto scan = core::classify("sct211-0001/2022", true);
    TEST_ASSERT_TRUE(scan.kind == ScanKind::Barcode);
    TEST_ASSERT_EQUAL_STRING("SCT211-0001/2022", scan.text.c_str());
    TEST_ASSERT_TRUE(core::classify("SCT211-0001/2022", false).kind == ScanKind::Unknown);
    TEST_ASSERT_TRUE(core::classify("ab", true).kind == ScanKind::Unknown);
    TEST_ASSERT_TRUE(core::classify("/SCT211", true).kind == ScanKind::Unknown);
    TEST_ASSERT_TRUE(core::classify("SCT 211", true).kind == ScanKind::Unknown);
}

void test_already_recorded() {
    TEST_ASSERT_TRUE(core::isAlreadyRecorded(409, "This student is already recorded present for this class."));
    TEST_ASSERT_FALSE(core::isAlreadyRecorded(409, "This class session has ended."));
    TEST_ASSERT_FALSE(core::isAlreadyRecorded(404, "already recorded"));
}

void test_battery() {
    TEST_ASSERT_EQUAL_INT(-1, core::batteryPercent(0));
    TEST_ASSERT_EQUAL_INT(100, core::batteryPercent(2100));
    TEST_ASSERT_EQUAL_INT(0, core::batteryPercent(1650));
    TEST_ASSERT_EQUAL_INT(50, core::batteryPercent(1875));
}

void test_slot_key_fits_nvs() {
    auto key = core::slotKey("8F1C2D3E-4A5B-6C7D-8E9F-001122334455");
    TEST_ASSERT_EQUAL_STRING("f8f1c2d3e4a5b6c", key.c_str());
    TEST_ASSERT_TRUE(key.size() <= 15);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_link_code_in_either_state);
    RUN_TEST(test_pairing_code_only_before_pairing);
    RUN_TEST(test_barcode_once_paired);
    RUN_TEST(test_already_recorded);
    RUN_TEST(test_battery);
    RUN_TEST(test_slot_key_fits_nvs);
    return UNITY_END();
}
