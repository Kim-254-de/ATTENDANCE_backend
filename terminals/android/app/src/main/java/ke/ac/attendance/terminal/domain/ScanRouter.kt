package ke.ac.attendance.terminal.domain

/**
 * What a scanned or typed code is for. One scanner serves everything: the
 * pairing code from the department's screen, the link code from the
 * lecturer's screen, and students' ID card barcodes.
 */
sealed interface Scan {
    /** `ATL1.<session>.<expiry>.<signature>`, from the lecturer's "Link a terminal". */
    data class Link(val code: String) : Scan
    /** `ABCDE-FGHJK` from the department's devices page. Only meaningful before pairing. */
    data class Pairing(val code: String) : Scan
    /** A registration number from a student ID card, e.g. `SCT211-0001/2022`. */
    data class Barcode(val registrationNumber: String) : Scan
    data class Unknown(val text: String) : Scan
}

object ScanRouter {
    private val PAIRING = Regex("^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$")
    // The backend's barcodeCheckInSchema: 3-64 chars, letters, digits, / . _ -
    private val BARCODE = Regex("^[A-Za-z0-9][A-Za-z0-9/._-]{2,63}$")

    fun classify(raw: String, paired: Boolean): Scan {
        val text = raw.trim()
        return when {
            text.startsWith("ATL1.") -> Scan.Link(text)
            !paired && PAIRING.matches(text) -> Scan.Pairing(text.uppercase())
            paired && BARCODE.matches(text) -> Scan.Barcode(text.uppercase())
            else -> Scan.Unknown(text)
        }
    }
}
