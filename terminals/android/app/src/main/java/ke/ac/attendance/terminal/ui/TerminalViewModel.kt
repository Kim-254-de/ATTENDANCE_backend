package ke.ac.attendance.terminal.ui

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ke.ac.attendance.terminal.data.EncryptedTerminalStore
import ke.ac.attendance.terminal.data.TerminalApi
import ke.ac.attendance.terminal.domain.TerminalEngine
import ke.ac.attendance.terminal.hardware.FingerprintReader
import ke.ac.attendance.terminal.hardware.SimulatedFingerprintReader
import ke.ac.attendance.terminal.hardware.deviceReport

/**
 * Wires the engine to Android. Swap [createFingerprintReader] for the vendor
 * SDK's reader once the handheld model is chosen (README).
 */
class TerminalViewModel(app: Application) : AndroidViewModel(app) {
    val store = EncryptedTerminalStore(app)
    val reader: FingerprintReader = createFingerprintReader(app)
    val engine = TerminalEngine(TerminalApi(store), store, reader, { deviceReport(app) }, viewModelScope).also { it.start() }

    /** Scanner settings for handhelds whose scanner sends a broadcast instead of keystrokes. */
    private val scannerPrefs = app.getSharedPreferences("scanner", Context.MODE_PRIVATE)
    var broadcastAction: String
        get() = scannerPrefs.getString("action", "") ?: ""
        set(value) = scannerPrefs.edit().putString("action", value.trim()).apply()
    var broadcastExtra: String
        get() = scannerPrefs.getString("extra", "") ?: ""
        set(value) = scannerPrefs.edit().putString("extra", value.trim()).apply()

    override fun onCleared() {
        engine.stop()
    }
}

@Suppress("UNUSED_PARAMETER")
fun createFingerprintReader(context: Context): FingerprintReader = SimulatedFingerprintReader()
