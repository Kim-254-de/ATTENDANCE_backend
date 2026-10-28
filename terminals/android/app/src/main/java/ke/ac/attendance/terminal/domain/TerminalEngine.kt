package ke.ac.attendance.terminal.domain

import ke.ac.attendance.terminal.data.ApiException
import ke.ac.attendance.terminal.data.CheckInResult
import ke.ac.attendance.terminal.data.Command
import ke.ac.attendance.terminal.data.HeartbeatReport
import ke.ac.attendance.terminal.data.SessionInfo
import ke.ac.attendance.terminal.data.TerminalBackend
import ke.ac.attendance.terminal.data.TerminalInfo
import ke.ac.attendance.terminal.data.TerminalStore
import ke.ac.attendance.terminal.hardware.EnrolResult
import ke.ac.attendance.terminal.hardware.FingerResult
import ke.ac.attendance.terminal.hardware.FingerprintReader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/** What the screen shows. */
data class UiState(
    val paired: Boolean,
    val terminal: TerminalInfo? = null,
    val session: SessionInfo? = null,
    val online: Boolean = true,
    /** The outcome of the last read, shown big until the next one. */
    val feedback: Feedback? = null,
    /** An enrolment or removal in progress, with what to tell the person holding the device. */
    val task: String? = null,
)

sealed interface Feedback {
    data class Recorded(val name: String?, val registrationNumber: String?, val via: String) : Feedback
    data class AlreadyRecorded(val message: String) : Feedback
    data class Refused(val message: String) : Feedback
    data class Info(val message: String) : Feedback
}

/**
 * The terminal's behaviour, independent of Android so it can be unit tested
 * (backend docs/terminals.md is the contract it follows).
 *
 *  - Unpaired: the only thing it does is pair, from the department's code.
 *  - Paired: it reports in every [heartbeatMs], links to a class from the
 *    lecturer's code, and records barcodes and fingerprints for that class.
 *  - When the department queues enrolment work, it pauses check-ins, carries
 *    the work out on the fingerprint reader, then resumes.
 *  - A 401 from the server means the department marked it lost, retired or
 *    re-paired it: it forgets its key and goes back to unpaired.
 */
class TerminalEngine(
    private val backend: TerminalBackend,
    private val store: TerminalStore,
    private val reader: FingerprintReader?,
    private val report: () -> HeartbeatReport,
    private val scope: CoroutineScope,
    private val heartbeatMs: Long = 60_000,
) {
    private val _state = MutableStateFlow(UiState(paired = store.key != null))
    val state: StateFlow<UiState> = _state

    /** One thing at a time on the reader: enrolment and identification both need it. */
    private val readerLock = Mutex()
    private var heartbeatJob: Job? = null
    private var fingerJob: Job? = null

    fun start() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                if (_state.value.paired) heartbeatOnce()
                delay(heartbeatMs)
            }
        }
    }

    fun stop() {
        heartbeatJob?.cancel()
        fingerJob?.cancel()
    }

    /** Anything the scanner, camera or keyboard produced. */
    fun onScan(text: String) {
        scope.launch { handleScan(text) }
    }

    suspend fun handleScan(text: String) {
        when (val scan = ScanRouter.classify(text, _state.value.paired)) {
            is Scan.Pairing -> pair(scan.code)
            is Scan.Link -> link(scan.code)
            is Scan.Barcode -> checkIn(via = "ID card") { backend.checkInBarcode(scan.registrationNumber) }
            is Scan.Unknown -> show(
                Feedback.Refused(
                    if (_state.value.paired) "Not a student ID card or a class code." else "Scan the pairing code from your department's Terminals page.",
                ),
            )
        }
    }

    suspend fun pair(code: String) {
        try {
            val result = backend.pair(code)
            store.key = result.key
            _state.update { UiState(paired = true, terminal = result.terminal, session = result.session) }
            show(Feedback.Info("Paired as ${result.terminal.code}. Ask the lecturer to show their class code."))
        } catch (e: Exception) {
            refuse(e)
        }
    }

    suspend fun heartbeatOnce() {
        try {
            val device = backend.heartbeat(report())
            applySession(device.terminal, device.session, online = true)
            if (device.pendingCommands > 0) runCommands()
        } catch (e: IOException) {
            _state.update { it.copy(online = false) }
        } catch (e: ApiException) {
            if (e.status == 401) unpair() else _state.update { it.copy(online = true) }
        }
    }

    suspend fun link(code: String) {
        if (!_state.value.paired) return show(Feedback.Refused("Pair this terminal with your department first."))
        try {
            val device = backend.link(code)
            applySession(device.terminal, device.session, online = true)
            show(Feedback.Info("Recording for ${device.session?.unitCode ?: "the class"}."))
        } catch (e: Exception) {
            refuse(e)
        }
    }

    suspend fun unlink() {
        try {
            val device = backend.unlink()
            applySession(device.terminal, device.session, online = true)
        } catch (e: Exception) {
            refuse(e)
        }
    }

    /** A finger the reader matched (or didn't). */
    suspend fun handleFinger(result: FingerResult) {
        when (result) {
            is FingerResult.Match -> checkIn(via = "fingerprint") { backend.checkInFinger(result.slot) }
            FingerResult.NoMatch -> show(Feedback.Refused("Fingerprint not recognised on this terminal. See your department to enrol it, or use your ID card."))
            is FingerResult.Error -> show(Feedback.Refused(result.message))
        }
    }

    /**
     * Records one read. A timeout is retried once, and a 409 "already
     * recorded" on that retry is the first attempt having landed, which is
     * success (backend card-check-in.md "Retry carefully").
     */
    private suspend fun checkIn(via: String, call: suspend () -> CheckInResult) {
        if (_state.value.session == null) return show(Feedback.Refused("Not linked to a class. Scan the code on the lecturer's screen."))
        var retried = false
        while (true) {
            try {
                val result = call()
                return show(Feedback.Recorded(result.student.fullName, result.student.registrationNumber, via))
            } catch (e: IOException) {
                if (retried) return show(Feedback.Refused("No connection. Check Wi-Fi or mobile data, then try again."))
                retried = true
            } catch (e: ApiException) {
                if (e.status == 409 && e.message.contains("already recorded", ignoreCase = true)) {
                    return show(if (retried) Feedback.Recorded(null, null, via) else Feedback.AlreadyRecorded(e.message))
                }
                if (e.status == 409 && e.message.contains("not linked", ignoreCase = true)) {
                    _state.update { it.copy(session = null) }
                    restartFingerLoop()
                }
                return refuse(e)
            }
        }
    }

    /** Enrolment and removal the department queued for this device. Check-ins pause meanwhile. */
    suspend fun runCommands() {
        val queued = try {
            backend.commands()
        } catch (e: Exception) {
            return
        }
        if (queued.isEmpty()) return
        fingerJob?.cancel()
        try {
            readerLock.withLock { for (command in queued) runCommand(command) }
        } finally {
            _state.update { it.copy(task = null) }
            restartFingerLoop()
        }
    }

    private suspend fun runCommand(command: Command) {
        val who = command.student.fullName ?: command.student.registrationNumber ?: "the student"
        val reader = reader ?: return failCommand(command, "This terminal has no fingerprint reader.")
        try {
            when (command.kind) {
                "ENROL_FINGERPRINT" -> {
                    _state.update { it.copy(task = "Enrol $who${command.label?.let { l -> " ($l)" } ?: ""}: place finger on the reader") }
                    when (val stored = reader.enrol { prompt -> _state.update { it.copy(task = "$who: $prompt") } }) {
                        is EnrolResult.Stored -> {
                            try {
                                val done = backend.complete(command.id, stored.slot)
                                done.fingerprintId?.let { store.rememberSlot(it, stored.slot) }
                                show(Feedback.Info("Enrolled $who."))
                            } catch (e: ApiException) {
                                // The server would not take it (cancelled meanwhile, slot clash): don't leave an orphan template.
                                reader.delete(stored.slot)
                                show(Feedback.Refused(e.message))
                            }
                        }
                        is EnrolResult.Failed -> failCommand(command, stored.reason)
                    }
                }
                "DELETE_FINGERPRINT" -> {
                    _state.update { it.copy(task = "Removing $who's fingerprint") }
                    val id = command.fingerprintId
                    val slot = id?.let { store.slotFor(it) }
                    if (slot != null) reader.delete(slot)
                    backend.complete(command.id, null)
                    if (id != null) store.forgetSlot(id)
                }
                else -> failCommand(command, "This app version does not know how to do ${command.kind}.")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiException && e.status == 401) return unpair()
            // Left pending on the server; the next heartbeat tries again.
        }
    }

    private suspend fun failCommand(command: Command, reason: String) {
        runCatching { backend.fail(command.id, reason) }
        show(Feedback.Refused(reason))
    }

    private fun applySession(terminal: TerminalInfo, session: SessionInfo?, online: Boolean) {
        val before = _state.value.session?.sessionId
        _state.update { it.copy(terminal = terminal, session = session, online = online) }
        if (before != session?.sessionId) restartFingerLoop()
    }

    /** Waits for fingers while linked to a class that takes them. */
    private fun restartFingerLoop() {
        fingerJob?.cancel()
        val reader = reader ?: return
        if (_state.value.session?.accepts?.contains("FINGERPRINT") != true) return
        fingerJob = scope.launch {
            while (isActive) {
                val result = readerLock.withLock { reader.identify() }
                handleFinger(result)
            }
        }
    }

    private fun unpair() {
        store.forgetKey()
        fingerJob?.cancel()
        _state.value = UiState(paired = false, feedback = Feedback.Refused("This terminal was switched off or re-paired by the department. Pair it again."))
    }

    private fun refuse(e: Exception) {
        when {
            e is ApiException && e.status == 401 && _state.value.paired -> unpair()
            e is ApiException -> show(Feedback.Refused(e.message))
            e is IOException -> {
                _state.update { it.copy(online = false) }
                show(Feedback.Refused("No connection. Check Wi-Fi or mobile data, then try again."))
            }
            else -> show(Feedback.Refused(e.message ?: "Something went wrong."))
        }
    }

    private fun show(feedback: Feedback) {
        _state.update { it.copy(feedback = feedback) }
    }
}
