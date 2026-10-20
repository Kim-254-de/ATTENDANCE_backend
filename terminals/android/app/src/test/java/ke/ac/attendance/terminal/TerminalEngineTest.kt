package ke.ac.attendance.terminal

import ke.ac.attendance.terminal.data.ApiException
import ke.ac.attendance.terminal.data.CheckInResult
import ke.ac.attendance.terminal.data.Command
import ke.ac.attendance.terminal.data.CompleteResult
import ke.ac.attendance.terminal.data.DeviceState
import ke.ac.attendance.terminal.data.HeartbeatReport
import ke.ac.attendance.terminal.data.MemoryTerminalStore
import ke.ac.attendance.terminal.data.PairResult
import ke.ac.attendance.terminal.data.SessionInfo
import ke.ac.attendance.terminal.data.StudentRef
import ke.ac.attendance.terminal.data.TerminalBackend
import ke.ac.attendance.terminal.data.TerminalInfo
import ke.ac.attendance.terminal.domain.Feedback
import ke.ac.attendance.terminal.domain.TerminalEngine
import ke.ac.attendance.terminal.hardware.EnrolResult
import ke.ac.attendance.terminal.hardware.FingerResult
import ke.ac.attendance.terminal.hardware.FingerprintReader
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

private val TERMINAL = TerminalInfo("TERM-01", null, listOf("BARCODE", "FINGERPRINT"))
private val SESSION = SessionInfo("s1", "COSC 205", "Algorithms", "OPEN", "a", "b", listOf("BARCODE", "FINGERPRINT"))

/** The server, as a script the test controls. */
private class FakeBackend : TerminalBackend {
    var session: SessionInfo? = null
    var commands = mutableListOf<Command>()
    var pending = 0
    val checkIns = mutableListOf<String>()
    val completed = mutableListOf<Pair<String, String?>>()
    val failed = mutableListOf<Pair<String, String>>()
    /** Thrown by the next check-in calls, in order. */
    val checkInErrors = ArrayDeque<Exception>()
    var heartbeatError: Exception? = null

    override suspend fun pair(pairingCode: String) =
        if (pairingCode == "ABCDE-FGHJK") PairResult("key-1", TERMINAL) else throw ApiException(400, "VALIDATION_FAILED", "This pairing code is not valid or has expired.")

    override suspend fun heartbeat(report: HeartbeatReport): DeviceState {
        heartbeatError?.let { throw it }
        return DeviceState(TERMINAL, session, pending)
    }

    override suspend fun link(linkCode: String): DeviceState {
        if (!linkCode.endsWith(".good")) throw ApiException(403, "FORBIDDEN", "This terminal belongs to another department and can't record for this class.")
        session = SESSION
        return DeviceState(TERMINAL, session)
    }

    override suspend fun unlink(): DeviceState { session = null; return DeviceState(TERMINAL, null) }

    private fun record(what: String): CheckInResult {
        checkInErrors.removeFirstOrNull()?.let { throw it }
        checkIns += what
        return CheckInResult("r", "s1", "COSC 205", "t", StudentRef("Amina Wanjiku", "SCT211-0001/2022"))
    }

    override suspend fun checkInBarcode(barcode: String) = record("barcode:$barcode")
    override suspend fun checkInFinger(fingerRef: String) = record("finger:$fingerRef")
    override suspend fun commands(): List<Command> = commands.toList()

    override suspend fun complete(commandId: String, fingerRef: String?): CompleteResult {
        completed += commandId to fingerRef
        commands.removeAll { it.id == commandId }
        pending = commands.size
        return CompleteResult(if (fingerRef != null) "fp-$commandId" else null)
    }

    override suspend fun fail(commandId: String, reason: String) {
        failed += commandId to reason
        commands.removeAll { it.id == commandId }
        pending = commands.size
    }
}

/** A reader that enrols into a fixed slot and never sees a finger on its own. */
private class FakeReader(private val enrolResult: EnrolResult = EnrolResult.Stored("7")) : FingerprintReader {
    val deleted = mutableListOf<String>()
    override suspend fun identify(): FingerResult = awaitCancellation()
    override suspend fun enrol(prompt: (String) -> Unit) = enrolResult
    override suspend fun delete(slot: String) { deleted += slot }
}

class TerminalEngineTest {
    private fun TestScope.engine(backend: FakeBackend, store: MemoryTerminalStore, reader: FingerprintReader? = FakeReader()) =
        TerminalEngine(backend, store, reader, { HeartbeatReport() }, backgroundScope)

    @Test
    fun `pairs from the department's code and keeps the key`() = runTest {
        val store = MemoryTerminalStore()
        val engine = engine(FakeBackend(), store)
        engine.handleScan("abcde-fghjk")
        assertEquals("key-1", store.key)
        assertTrue(engine.state.value.paired)
        assertEquals("TERM-01", engine.state.value.terminal?.code)
    }

    @Test
    fun `a bad pairing code shows the server's reason and stays unpaired`() = runTest {
        val store = MemoryTerminalStore()
        val engine = engine(FakeBackend(), store)
        engine.handleScan("ZZZZZ-ZZZZZ")
        assertNull(store.key)
        assertTrue((engine.state.value.feedback as Feedback.Refused).message.contains("not valid"))
    }

    @Test
    fun `links to a class, then records a barcode for it`() = runTest {
        val backend = FakeBackend()
        val engine = engine(backend, MemoryTerminalStore(key = "k"))
        engine.handleScan("SCT211-0001/2022")
        assertTrue((engine.state.value.feedback as Feedback.Refused).message.contains("Not linked"))

        engine.handleScan("ATL1.s1.123.good")
        assertEquals("COSC 205", engine.state.value.session?.unitCode)
        engine.handleScan("sct211-0001/2022")
        assertEquals(listOf("barcode:SCT211-0001/2022"), backend.checkIns)
        assertEquals("Amina Wanjiku", (engine.state.value.feedback as Feedback.Recorded).name)
    }

    @Test
    fun `refuses another department's class with the server's message`() = runTest {
        val engine = engine(FakeBackend(), MemoryTerminalStore(key = "k"))
        engine.handleScan("ATL1.s1.123.bad")
        assertNull(engine.state.value.session)
        assertTrue((engine.state.value.feedback as Feedback.Refused).message.contains("another department"))
    }

    @Test
    fun `a timeout is retried once, and already recorded on the retry counts as recorded`() = runTest {
        val backend = FakeBackend().apply { session = SESSION }
        val engine = engine(backend, MemoryTerminalStore(key = "k"))
        engine.heartbeatOnce()
        backend.checkInErrors += IOException("timeout")
        backend.checkInErrors += ApiException(409, "CONFLICT", "This student is already recorded present for this class.")
        engine.handleScan("SCT211-0001/2022")
        assertTrue(engine.state.value.feedback is Feedback.Recorded)
    }

    @Test
    fun `a second scan of the same student says already recorded`() = runTest {
        val backend = FakeBackend().apply { session = SESSION }
        val engine = engine(backend, MemoryTerminalStore(key = "k"))
        engine.heartbeatOnce()
        backend.checkInErrors += ApiException(409, "CONFLICT", "This student is already recorded present for this class.")
        engine.handleScan("SCT211-0001/2022")
        assertTrue(engine.state.value.feedback is Feedback.AlreadyRecorded)
    }

    @Test
    fun `a matched finger is checked in by its slot, an unmatched one is refused`() = runTest {
        val backend = FakeBackend().apply { session = SESSION }
        val engine = engine(backend, MemoryTerminalStore(key = "k"))
        engine.heartbeatOnce()
        engine.handleFinger(FingerResult.Match("12"))
        assertEquals(listOf("finger:12"), backend.checkIns)
        engine.handleFinger(FingerResult.NoMatch)
        assertTrue((engine.state.value.feedback as Feedback.Refused).message.contains("not recognised"))
    }

    @Test
    fun `carries out a queued enrolment and remembers which slot holds it`() = runTest {
        val backend = FakeBackend().apply {
            commands += Command("c1", "ENROL_FINGERPRINT", StudentRef("Amina", "SCT211-0001/2022"), null, "right index", "t")
            pending = 1
        }
        val store = MemoryTerminalStore(key = "k")
        val engine = engine(backend, store)
        engine.heartbeatOnce()
        assertEquals(listOf("c1" to "7"), backend.completed)
        assertEquals("7", store.slotFor("fp-c1"))
        assertNull(engine.state.value.task)
    }

    @Test
    fun `removes a revoked fingerprint from the slot it was stored in`() = runTest {
        val backend = FakeBackend().apply {
            commands += Command("c2", "DELETE_FINGERPRINT", StudentRef("Amina", null), "fp-9", null, "t")
            pending = 1
        }
        val store = MemoryTerminalStore(key = "k").apply { rememberSlot("fp-9", "33") }
        val reader = FakeReader()
        engine(backend, store, reader).heartbeatOnce()
        assertEquals(listOf("33"), reader.deleted)
        assertEquals(listOf("c2" to null), backend.completed)
        assertNull(store.slotFor("fp-9"))
    }

    @Test
    fun `reports an enrolment the reader could not do`() = runTest {
        val backend = FakeBackend().apply {
            commands += Command("c3", "ENROL_FINGERPRINT", StudentRef("Amina", null), null, null, "t")
            pending = 1
        }
        engine(backend, MemoryTerminalStore(key = "k"), FakeReader(EnrolResult.Failed("finger too dry"))).heartbeatOnce()
        assertEquals(listOf("c3" to "finger too dry"), backend.failed)
    }

    @Test
    fun `forgets its key but keeps its fingerprint slots when the department cuts it off`() = runTest {
        val backend = FakeBackend().apply { heartbeatError = ApiException(401, "INVALID_API_KEY", "switched off") }
        val store = MemoryTerminalStore(key = "k").apply { rememberSlot("fp-1", "1") }
        val engine = engine(backend, store)
        engine.heartbeatOnce()
        assertFalse(engine.state.value.paired)
        assertNull(store.key)
        // Enrolments are filed under the terminal's code, which survives re-pairing.
        assertEquals("1", store.slotFor("fp-1"))
    }

    @Test
    fun `goes offline on a network error without unpairing`() = runTest {
        val backend = FakeBackend().apply { heartbeatError = IOException("no route") }
        val store = MemoryTerminalStore(key = "k")
        val engine = engine(backend, store)
        engine.heartbeatOnce()
        assertFalse(engine.state.value.online)
        assertEquals("k", store.key)
    }
}
