package ke.ac.attendance.terminal

import ke.ac.attendance.terminal.domain.Scan
import ke.ac.attendance.terminal.domain.ScanRouter
import org.junit.Assert.assertEquals
import org.junit.Test

class ScanRouterTest {
    @Test
    fun `link codes are recognised whether or not the device is paired`() {
        val code = "ATL1.8f1c0000-0000-0000-0000-000000000000.1760000000.abc"
        assertEquals(Scan.Link(code), ScanRouter.classify(" $code\n", paired = true))
        assertEquals(Scan.Link(code), ScanRouter.classify(code, paired = false))
    }

    @Test
    fun `before pairing a ten character code is the pairing code, upper-cased`() {
        assertEquals(Scan.Pairing("ABCDE-FGHJK"), ScanRouter.classify("abcde-fghjk", paired = false))
        assertEquals(Scan.Pairing("ABCDEFGHJK"), ScanRouter.classify("ABCDEFGHJK", paired = false))
    }

    @Test
    fun `once paired a registration number is a student barcode`() {
        assertEquals(Scan.Barcode("SCT211-0001/2022"), ScanRouter.classify("sct211-0001/2022", paired = true))
        // The same text before pairing is not a pairing code.
        assertEquals(Scan.Unknown("SCT211-0001/2022"), ScanRouter.classify("SCT211-0001/2022", paired = false))
    }

    @Test
    fun `junk is unknown`() {
        assertEquals(Scan.Unknown("hello world"), ScanRouter.classify("hello world", paired = true))
        assertEquals(Scan.Unknown("ab"), ScanRouter.classify("ab", paired = true))
    }
}
