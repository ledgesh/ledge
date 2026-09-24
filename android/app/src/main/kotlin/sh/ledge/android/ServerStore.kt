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
    val usesPassword: Boolean get() = auth == "password"

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
        /**
         * What a user typed, refused with a reason or accepted: iOS's rule
         * (ios/Sources/ShellConfig.swift). The Mac lets ssh supply the local
         * username, and a phone has none worth offering, so the account is
         * required here rather than surfacing later as a refused key.
         */
        fun problem(destination: String): String? {
            val text = destination.trim()
            if (text.isEmpty()) return "Enter the server, as user@host."
            if (text.any { it.isWhitespace() }) return "An ssh destination has no spaces in it."
            val parts = text.split('@')
            if (parts.size != 2 || parts[0].isEmpty() || parts[1].isEmpty()) {
                return "Write it as user@host: Ledge signs in as an account on that machine."
            }
            if (text.startsWith("-")) return "An ssh destination cannot start with a dash."
            if (text.contains(':')) return "Leave the port out of the address: it has a field of its own."
            return null
        }

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

/**
 * Every server this phone knows, and which one it dials: the counterpart of
 * iOS's ServerStore. The page owns the list's shape and every rule about what
 * may be added, renamed or removed (mainview/lib/nativeBridge.ts); this end
 * stores the bytes, and the shell's own screens select and pair (ios.md §4).
 */
class ServerStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("ledge", Context.MODE_PRIVATE)
    private val passwords = ServerPassword(context)

    class Stored(val servers: List<ServerRecord>, val selected: String)

    /** The list, self-healed: a record with no id or an address that is not
     * one is not a server, and a selection naming nothing falls back to the
     * first one there is. */
    fun load(): Stored {
        val raw = prefs.getString(LIST, null) ?: return Stored(emptyList(), "")
        return runCatching {
            val o = JSONObject(raw)
            val rows = o.optJSONArray("servers") ?: JSONArray()
            val seen = HashSet<String>()
            val servers = (0 until rows.length())
                .mapNotNull { rows.optJSONObject(it)?.let(ServerRecord::fromJson) }
                .filter { it.id.isNotEmpty() && ServerRecord.problem(it.destination) == null && seen.add(it.id) }
            val selected = o.optString("selected").takeIf { id -> servers.any { it.id == id } } ?: servers.firstOrNull()?.id.orEmpty()
            Stored(servers, selected)
        }.getOrElse { Stored(emptyList(), "") }
    }

    /** A record that leaves the list takes its password with it (ServerPassword.keepOnly). */
    fun save(servers: List<ServerRecord>, selected: String) {
        val rows = JSONArray().apply { servers.forEach { put(it.toJson()) } }
        prefs.edit().putString(LIST, JSONObject().put("servers", rows).put("selected", selected).toString()).apply()
        passwords.keepOnly(servers.map { it.id })
    }

    /** The selected record, if it is one this app can dial. A record with no
     * pin is not: connecting to it would mean trusting whatever answers, which
     * remote.md §4 does not allow. */
    fun selected(): ServerRecord? {
        val stored = load()
        return stored.servers.firstOrNull { it.id == stored.selected }?.takeIf { it.hostKey.isNotEmpty() }
    }

    fun password(id: String): String? = passwords.read(id)

    fun keepPassword(id: String, password: String?): Boolean =
        if (password == null) true.also { passwords.forget(id) } else passwords.write(id, password)

    /**
     * Add a freshly pinned server, or re-pin the one already at that address
     * and port, which is what a host key belongs to. Only a key a person
     * confirmed by eye comes here: a pairing code's goes to the overload
     * below, which never re-pins. Null when the password would not store.
     */
    fun pair(destination: String, port: Int, hostKey: String, auth: String, password: String?): ServerRecord? {
        val stored = load()
        val at = stored.servers.indexOfFirst { it.destination == destination && it.port == port }
        return if (at >= 0) update(stored, at, hostKey, auth, password) else append(stored, destination, port, hostKey, auth, password)
    }

    /** Add or update the server a pairing code names, or null when the stored
     * list now refuses the code. The rule is `PairingCode.match`, checked again
     * here because the page can save the list while the dial is out. */
    fun pair(code: PairingCode, hostKey: String, auth: String, password: String?): ServerRecord? {
        val stored = load()
        return when (val match = code.match(known(stored))) {
            is PairingCode.Match.Conflict -> null
            is PairingCode.Match.Pinned -> {
                val at = stored.servers.indexOfFirst { it.id == match.id }
                if (at < 0 || stored.servers[at].hostKey != hostKey) null else update(stored, at, hostKey, auth, password)
            }
            is PairingCode.Match.Unpinned -> {
                val at = stored.servers.indexOfFirst { it.id == match.id }
                if (at < 0) null else update(stored, at, hostKey, auth, password)
            }
            PairingCode.Match.New -> append(stored, code.destination, code.port, hostKey, auth, password)
        }
    }

    /** The stored list as `PairingCode.match` reads it. */
    fun known(stored: Stored = load()): List<PairingCode.Known> = stored.servers.map {
        PairingCode.Known(it.id, it.destination, it.port, if (it.hostKey.isEmpty()) "" else HostKeyOffer(it.hostKey).fingerprint)
    }

    /** Point at one of the records already stored: the one write the server
     * list screen makes. */
    fun select(id: String) {
        val stored = load()
        if (stored.servers.any { it.id == id }) save(stored.servers, id)
    }

    /** Forget one record's pin but keep the record: the case this exists for
     * is a host key that changed, where the address is still the one the user
     * meant and the key is the thing to look at again. */
    fun forgetPin(id: String) {
        val stored = load()
        save(stored.servers.map { if (it.id == id) it.copy(hostKey = "") else it }, stored.selected)
    }

    /**
     * A server named at launch, added or updated and selected: how
     * `bun run android -- --server` points a debug build at a scratch server
     * without a person tapping Trust. Matched by address, so relaunching with
     * the same one updates its pin rather than adding a row.
     */
    fun adopt(destination: String, port: Int, hostKey: String) {
        pair(destination, port, hostKey, "key", null)
    }

    // The credential before the record, so a saved list never names a
    // password door with nothing behind it.
    private fun update(stored: Stored, at: Int, hostKey: String, auth: String, password: String?): ServerRecord? {
        val record = stored.servers[at].copy(hostKey = hostKey, auth = auth)
        if (auth == "password" && (password == null || !passwords.write(record.id, password))) return null
        save(stored.servers.mapIndexed { i, it -> if (i == at) record else it }, record.id)
        return record
    }

    private fun append(stored: Stored, destination: String, port: Int, hostKey: String, auth: String, password: String?): ServerRecord? {
        // Named after the machine, because pairing asks one question and a
        // second field for a label it can guess would be a second one. It is
        // editable from the connection dialog afterwards.
        val record = ServerRecord(newId(), destination.substringAfter('@'), destination, port, hostKey, auth)
        if (auth == "password" && (password == null || !passwords.write(record.id, password))) return null
        save(stored.servers + record, record.id)
        return record
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
