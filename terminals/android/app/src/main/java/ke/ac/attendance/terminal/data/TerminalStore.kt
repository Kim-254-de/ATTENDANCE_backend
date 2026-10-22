package ke.ac.attendance.terminal.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import ke.ac.attendance.terminal.BuildConfig

/**
 * What the terminal keeps between restarts: the server it talks to, its key,
 * and which local fingerprint slot holds which server enrolment.
 *
 * The slot map is what lets the department remove a fingerprint later: the
 * server only knows the enrolment id (it stores just an HMAC of the slot), so
 * a DELETE command names the enrolment and the device looks up the slot here.
 */
interface TerminalStore {
    var baseUrl: String
    var key: String?
    fun slotFor(fingerprintId: String): String?
    fun rememberSlot(fingerprintId: String, slot: String)
    fun forgetSlot(fingerprintId: String)
    /**
     * Drops the key when the department cuts the device off. The slot map
     * stays: the server files enrolments under the terminal's code, which
     * survives re-pairing, so the fingerprints on this device are still valid.
     */
    fun forgetKey()
}

/** On the device: encrypted with a key held in the Android Keystore. */
class EncryptedTerminalStore(context: Context) : TerminalStore {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        "terminal",
        MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
        context,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    override var baseUrl: String
        get() = prefs.getString("baseUrl", null) ?: BuildConfig.DEFAULT_API_URL
        set(value) = prefs.edit().putString("baseUrl", value.trim()).apply()

    override var key: String?
        get() = prefs.getString("key", null)
        set(value) = prefs.edit().putString("key", value).apply()

    override fun slotFor(fingerprintId: String): String? = prefs.getString("slot.$fingerprintId", null)
    override fun rememberSlot(fingerprintId: String, slot: String) = prefs.edit().putString("slot.$fingerprintId", slot).apply()
    override fun forgetSlot(fingerprintId: String) = prefs.edit().remove("slot.$fingerprintId").apply()

    override fun forgetKey() = prefs.edit().remove("key").apply()
}

/** For tests and previews. */
class MemoryTerminalStore(override var baseUrl: String = "http://localhost/api/v1", override var key: String? = null) : TerminalStore {
    val slots = mutableMapOf<String, String>()
    override fun slotFor(fingerprintId: String) = slots[fingerprintId]
    override fun rememberSlot(fingerprintId: String, slot: String) { slots[fingerprintId] = slot }
    override fun forgetSlot(fingerprintId: String) { slots.remove(fingerprintId) }
    override fun forgetKey() { key = null }
}
