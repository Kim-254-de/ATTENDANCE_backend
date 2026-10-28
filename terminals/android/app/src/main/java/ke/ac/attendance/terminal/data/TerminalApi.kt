package ke.ac.attendance.terminal.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Everything the terminal asks the server. An interface so TerminalEngine can be tested without a network. */
interface TerminalBackend {
    suspend fun pair(pairingCode: String): PairResult
    suspend fun heartbeat(report: HeartbeatReport): DeviceState
    suspend fun link(linkCode: String): DeviceState
    suspend fun unlink(): DeviceState
    suspend fun checkInBarcode(barcode: String): CheckInResult
    suspend fun checkInFinger(fingerRef: String): CheckInResult
    suspend fun commands(): List<Command>
    suspend fun complete(commandId: String, fingerRef: String?): CompleteResult
    suspend fun fail(commandId: String, reason: String)
}

/**
 * The HTTP client. The base URL and key are read from the store on every call,
 * so pairing (which sets the key) and the setup screen (which sets the URL)
 * take effect without rebuilding anything.
 *
 * The server wraps every answer as `{ success, data }` or `{ success: false,
 * error: { code, message } }`; refusals become [ApiException] with the
 * server's own message, which the screen shows as-is.
 */
class TerminalApi(
    private val store: TerminalStore,
    private val client: OkHttpClient = defaultClient(),
) : TerminalBackend {

    @Serializable
    private data class ErrorBody(val code: String? = null, val message: String? = null)

    @Serializable
    private data class Envelope(val success: Boolean = false, val data: JsonElement? = null, val error: ErrorBody? = null)

    override suspend fun pair(pairingCode: String): PairResult =
        post("terminals/pair", buildJsonObject { put("pairingCode", pairingCode) }, PairResult.serializer(), authenticated = false)

    override suspend fun heartbeat(report: HeartbeatReport): DeviceState =
        post("terminals/heartbeat", json.encodeToJsonElement(HeartbeatReport.serializer(), report) as JsonObject, DeviceState.serializer())

    override suspend fun link(linkCode: String): DeviceState =
        post("terminals/link", buildJsonObject { put("linkCode", linkCode) }, DeviceState.serializer())

    override suspend fun unlink(): DeviceState = post("terminals/unlink", JsonObject(emptyMap()), DeviceState.serializer())

    override suspend fun checkInBarcode(barcode: String): CheckInResult =
        post("terminals/check-in", buildJsonObject { put("barcode", barcode) }, CheckInResult.serializer())

    override suspend fun checkInFinger(fingerRef: String): CheckInResult =
        post("terminals/check-in", buildJsonObject { put("fingerRef", fingerRef) }, CheckInResult.serializer())

    override suspend fun commands(): List<Command> = get("terminals/commands", ListSerializer(Command.serializer()))

    override suspend fun complete(commandId: String, fingerRef: String?): CompleteResult =
        post(
            "terminals/commands/$commandId/complete",
            buildJsonObject { if (fingerRef != null) put("fingerRef", fingerRef) },
            CompleteResult.serializer(),
        )

    override suspend fun fail(commandId: String, reason: String) {
        val body = buildJsonObject { put("reason", reason.take(200)) }
        send(request("terminals/commands/$commandId/fail", authenticated = true).post(body.toString().toRequestBody(JSON_TYPE)).build(), null as KSerializer<Unit>?)
    }

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T =
        send(request(path, authenticated = true).get().build(), serializer)!!

    private suspend fun <T> post(path: String, body: JsonObject, serializer: KSerializer<T>, authenticated: Boolean = true): T =
        send(request(path, authenticated).post(body.toString().toRequestBody(JSON_TYPE)).build(), serializer)!!

    private fun request(path: String, authenticated: Boolean): Request.Builder {
        val builder = Request.Builder().url("${store.baseUrl.trimEnd('/')}/$path").header("Accept", "application/json")
        if (authenticated) {
            val key = store.key ?: throw ApiException(401, "NOT_PAIRED", "This terminal is not paired.")
            builder.header("X-Terminal-Key", key)
        }
        return builder
    }

    private suspend fun <T> send(request: Request, serializer: KSerializer<T>?): T? = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val envelope = runCatching { json.decodeFromString(Envelope.serializer(), text) }.getOrNull()
            if (!response.isSuccessful || envelope == null || !envelope.success) {
                throw ApiException(
                    response.code,
                    envelope?.error?.code,
                    envelope?.error?.message ?: if (response.isSuccessful) "The server sent an answer this app cannot read." else "The server refused (HTTP ${response.code}).",
                )
            }
            if (serializer == null) null
            else json.decodeFromJsonElement(serializer, envelope.data ?: throw IOException("Empty response"))
        }
    }

    companion object {
        private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            // The backend host sleeps when idle; the first request after that can take a while.
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
