package ke.ac.attendance.terminal.hardware

/**
 * Built-in scanners on Android handhelds deliver a read in one of two ways,
 * set in the vendor's scanner settings:
 *
 *  - as keystrokes ("keyboard wedge"), ending with Enter: [WedgeBuffer]
 *    collects them;
 *  - as a broadcast intent with the text in an extra: MainActivity registers
 *    a receiver for the action and extra configured on the setup screen.
 *
 * Phones without a scanner use the camera button instead.
 */
class WedgeBuffer(private val onScan: (String) -> Unit) {
    private val buffer = StringBuilder()
    private var lastKeyAt = 0L

    /** Feeds one typed character. A pause longer than a scanner's makes it a fresh read. */
    fun onChar(char: Char, nowMs: Long) {
        if (nowMs - lastKeyAt > MAX_GAP_MS) buffer.clear()
        lastKeyAt = nowMs
        buffer.append(char)
    }

    /** Enter (or Tab, on some scanners) ends the read. */
    fun onEnd() {
        val text = buffer.toString().trim()
        buffer.clear()
        if (text.isNotEmpty()) onScan(text)
    }

    private companion object {
        const val MAX_GAP_MS = 300L
    }
}
