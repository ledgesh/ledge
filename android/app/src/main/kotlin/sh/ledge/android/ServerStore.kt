package sh.ledge.android

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * One server this phone knows (remote.md §8). The page's `ShellServer`
 * (mainview/lib/nativeBridge.ts) field for field: every rule about what may be
 * added or removed is the page's, and this end stores the bytes.
 */
data class ServerRecord(
    val id: String,
    val name: String,
    val destination: String,
    val port: Int,
    /** The pinned key's two fields, or "" once dropped. */
    val hostKey: String,
    val auth: String,
) {
    val portOrDefault: Int get() = if (port > 0) port else SshTransport.DEFAULT_PORT

    fun hostOnly(): String = destination.substringAfterLast('@')

    fun userAndHost(): Pair<String, String> {
        val at = destination.lastIndexOf('@')
        if (at <= 0 || at == destination.length - 1) {
            throw SshFailure("Write the server as user@host: Ledge signs in as an account on that machine.", needsPairing = false)
        }
        return destination.substring(0, at) to destination.substring(at + 1)
    }

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("destination", destination)
        .put("port", port).put("hostKey", hostKey).put("auth", auth)

    companion object {
        // Machine-written state self-heals (architecture.md §6): a missing
        // field costs its own default, never the whole list.
        fun fromJson(o: JSONObject) = ServerRecord(
            id = o.optString("id"),
            name = o.optString("name"),
            destination = o.optString("destination"),
            port = o.optInt("port", 0),
            hostKey = o.optString("hostKey"),
            auth = o.optString("auth", "key").ifEmpty { "key" },
        )
    }
}

/** The list and the selection, in the app's own preferences. */
class ServerStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("ledge", Context.MODE_PRIVATE)

    class Stored(val servers: List<ServerRecord>, val selected: String)

    fun load(): Stored {
        val raw = prefs.getString(LIST, null) ?: return Stored(emptyList(), "")
        return runCatching {
            val o = JSONObject(raw)
            val rows = o.optJSONArray("servers") ?: JSONArray()
            val servers = (0 until rows.length())
                .mapNotNull { rows.optJSONObject(it)?.let(ServerRecord::fromJson) }
                .filter { it.id.isNotEmpty() && it.destination.isNotEmpty() }
            Stored(servers, o.optString("selected"))
        }.getOrElse { Stored(emptyList(), "") }
    }

    fun save(servers: List<ServerRecord>, selected: String) {
        val rows = JSONArray().apply { servers.forEach { put(it.toJson()) } }
        prefs.edit().putString(LIST, JSONObject().put("servers", rows).put("selected", selected).toString()).apply()
    }

    fun selected(): ServerRecord? {
        val stored = load()
        return stored.servers.firstOrNull { it.id == stored.selected }
    }

    /**
     * A server named at launch, added or updated and selected: the stand-in
     * for pairing until the phone has a pairing screen. Matched by address, so
     * relaunching with the same one updates its pin rather than adding a row.
     */
    fun adopt(destination: String, port: Int, hostKey: String) {
        val stored = load()
        val same = stored.servers.firstOrNull { it.destination == destination && it.port == port }
        val record = (same ?: ServerRecord(newId(), destination.substringAfterLast('@'), destination, port, "", "key"))
            .copy(hostKey = hostKey)
        save(stored.servers.filter { it.id != record.id } + record, record.id)
    }

    /** Who this client is (remote.md §5), minted once and kept. */
    val client: String
        get() = prefs.getString(CLIENT, null) ?: newId().also { prefs.edit().putString(CLIENT, it).apply() }

    private fun newId() = UUID.randomUUID().toString().replace("-", "")

    companion object {
        private const val LIST = "servers"
        private const val CLIENT = "client"

        /** What this device calls itself to the other clients on a server
         * (wire.ts `Hello.label`): the name its owner gave it, or the model. */
        fun label(context: Context): String =
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.ifBlank { null } ?: Build.MODEL
    }
}
