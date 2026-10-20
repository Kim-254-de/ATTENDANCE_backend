package ke.ac.attendance.terminal.hardware

import kotlinx.coroutines.channels.Channel

/**
 * The fingerprint sensor, whatever the handheld's vendor SDK looks like.
 *
 * Matching happens here, on the device: [identify] returns which of the
 * reader's own slots matched, and only that slot reference goes to the server.
 * No template or image ever leaves the device (backend docs/terminals.md).
 *
 * A real handheld gets its own implementation wrapping the vendor SDK (see
 * README "Adding a vendor fingerprint SDK"). Until the model is chosen,
 * [SimulatedFingerprintReader] stands in.
 */
interface FingerprintReader {
    /** Waits for a finger and matches it 1:N. */
    suspend fun identify(): FingerResult

    /** Takes a new finger (usually several presses) into a free slot and returns that slot. */
    suspend fun enrol(prompt: (String) -> Unit): EnrolResult

    /** Frees a slot so the finger no longer matches anyone. */
    suspend fun delete(slot: String)
}

sealed interface FingerResult {
    data class Match(val slot: String) : FingerResult
    data object NoMatch : FingerResult
    /** The sensor gave up: timeout, a smudged read. Not an answer about who it was. */
    data class Error(val message: String) : FingerResult
}

sealed interface EnrolResult {
    data class Stored(val slot: String) : EnrolResult
    data class Failed(val reason: String) : EnrolResult
}

/**
 * A stand-in sensor for development and demos: the operator types the "finger"
 * on screen. Slots are handed out from 1 upwards, and a typed slot matches if
 * it was enrolled and not deleted, as a real reader would behave.
 */
class SimulatedFingerprintReader : FingerprintReader {
    private val presses = Channel<String>(Channel.CONFLATED)
    private val stored = sortedSetOf<Int>()

    /** Called from the screen: "a finger in slot N was pressed". */
    fun press(slot: String) {
        presses.trySend(slot.trim())
    }

    override suspend fun identify(): FingerResult {
        val slot = presses.receive()
        return if (slot.toIntOrNull()?.let { it in stored } == true) FingerResult.Match(slot) else FingerResult.NoMatch
    }

    override suspend fun enrol(prompt: (String) -> Unit): EnrolResult {
        prompt("Simulated: press Enrol finger to store it")
        presses.receive()
        val slot = (1..MAX_SLOTS).firstOrNull { it !in stored } ?: return EnrolResult.Failed("The reader is full")
        stored += slot
        return EnrolResult.Stored(slot.toString())
    }

    override suspend fun delete(slot: String) {
        slot.toIntOrNull()?.let { stored -= it }
    }

    private companion object {
        const val MAX_SLOTS = 3000
    }
}
