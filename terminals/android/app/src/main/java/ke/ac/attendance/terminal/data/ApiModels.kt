package ke.ac.attendance.terminal.data

import kotlinx.serialization.Serializable

/**
 * The backend's shapes for a paired terminal (backend docs/terminals.md).
 * Fields the app does not use are ignored when parsing, so the server can add
 * to them without breaking deployed devices.
 */

@Serializable
data class TerminalInfo(
    val code: String,
    val label: String? = null,
    val capabilities: List<String> = emptyList(),
)

@Serializable
data class SessionInfo(
    val sessionId: String,
    val unitCode: String,
    val unitName: String? = null,
    val status: String,
    val opensAt: String,
    val closesAt: String,
    /** Which of this device's readers the class takes right now: BARCODE, CARD, FINGERPRINT. */
    val accepts: List<String> = emptyList(),
)

@Serializable
data class DeviceState(
    val terminal: TerminalInfo,
    val session: SessionInfo? = null,
    /** Only on heartbeat: queued enrolment work waiting at GET /terminals/commands. */
    val pendingCommands: Int = 0,
)

@Serializable
data class PairResult(
    val key: String,
    val terminal: TerminalInfo,
    val session: SessionInfo? = null,
)

@Serializable
data class StudentRef(
    val fullName: String? = null,
    val registrationNumber: String? = null,
)

@Serializable
data class CheckInResult(
    val recordId: String,
    val sessionId: String,
    val unitCode: String,
    val recordedAt: String,
    val student: StudentRef,
)

@Serializable
data class Command(
    val id: String,
    /** ENROL_FINGERPRINT or DELETE_FINGERPRINT. */
    val kind: String,
    val student: StudentRef,
    /** For DELETE: the enrolment whose slot to free, as recorded when it was enrolled. */
    val fingerprintId: String? = null,
    val label: String? = null,
    val createdAt: String,
)

@Serializable
data class CompleteResult(val fingerprintId: String? = null)

@Serializable
data class HeartbeatReport(
    val batteryPercent: Int? = null,
    /** WIFI or CELLULAR. */
    val network: String? = null,
    val appVersion: String? = null,
)

/** A refusal from the server: its HTTP status, error code and the message meant for people. */
class ApiException(val status: Int, val code: String?, override val message: String) : Exception(message)
