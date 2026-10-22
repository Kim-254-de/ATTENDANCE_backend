package ke.ac.attendance.terminal

import ke.ac.attendance.terminal.data.ApiException
import ke.ac.attendance.terminal.data.HeartbeatReport
import ke.ac.attendance.terminal.data.MemoryTerminalStore
import ke.ac.attendance.terminal.data.TerminalApi
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class TerminalApiTest {
    private val server = MockWebServer()
    private lateinit var store: MemoryTerminalStore
    private lateinit var api: TerminalApi

    @Before
    fun setUp() {
        server.start()
        store = MemoryTerminalStore(baseUrl = server.url("/api/v1/").toString(), key = "device-key")
        api = TerminalApi(store)
    }

    @After
    fun tearDown() = server.shutdown()

    private fun respond(code: Int, body: String) = server.enqueue(MockResponse().setResponseCode(code).setBody(body))

    @Test
    fun `pairing sends the code without a key and returns the device key`() = runTest {
        respond(200, """{"success":true,"data":{"key":"k123","terminal":{"code":"TERM-01","label":null,"capabilities":["BARCODE"]},"session":null}}""")
        val result = api.pair("ABCDE-FGHJK")
        assertEquals("k123", result.key)
        val request = server.takeRequest()
        assertEquals("/api/v1/terminals/pair", request.path)
        assertNull(request.getHeader("X-Terminal-Key"))
        assertEquals("""{"pairingCode":"ABCDE-FGHJK"}""", request.body.readUtf8())
    }

    @Test
    fun `heartbeat carries the key and reads the linked session and pending work`() = runTest {
        respond(200, """{"success":true,"data":{"terminal":{"code":"T","capabilities":["BARCODE","FINGERPRINT"]},
            "session":{"sessionId":"s1","unitCode":"COSC 205","unitName":null,"status":"OPEN","opensAt":"a","closesAt":"b","accepts":["FINGERPRINT"],"extra":1},
            "pendingCommands":2}}""")
        val state = api.heartbeat(HeartbeatReport(batteryPercent = 50, network = "WIFI", appVersion = "1.0.0"))
        assertEquals("COSC 205", state.session?.unitCode)
        assertEquals(2, state.pendingCommands)
        val request = server.takeRequest()
        assertEquals("device-key", request.getHeader("X-Terminal-Key"))
        assertTrue(request.body.readUtf8().contains("\"batteryPercent\":50"))
    }

    @Test
    fun `a refusal becomes an ApiException with the server's message`() = runTest {
        respond(409, """{"success":false,"error":{"code":"CONFLICT","message":"This student is already recorded present for this class."}}""")
        try {
            api.checkInBarcode("SCT211-0001/2022")
            fail("expected a refusal")
        } catch (e: ApiException) {
            assertEquals(409, e.status)
            assertEquals("CONFLICT", e.code)
            assertTrue(e.message.contains("already recorded"))
        }
    }

    @Test
    fun `an unpaired device does not call the server`() = runTest {
        store.key = null
        try {
            api.heartbeat(HeartbeatReport())
            fail("expected a refusal")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `completing an enrolment sends the slot`() = runTest {
        respond(200, """{"success":true,"data":{"fingerprintId":"fp-1"}}""")
        assertEquals("fp-1", api.complete("cmd-1", "12").fingerprintId)
        val request = server.takeRequest()
        assertEquals("/api/v1/terminals/commands/cmd-1/complete", request.path)
        assertEquals("""{"fingerRef":"12"}""", request.body.readUtf8())
    }
}
