package sh.ledge.android

/**
 * A pairing code: the server to dial and the host keys it offers, read from a
 * scanned or tapped link. The rules and their order are `shared/pairing.ts`'s,
 * as ios/Sources/PairingCode.swift takes them, and PairingCodeTest holds this
 * file to the same vectors (remote.md §4b). It imports nothing from Android, so
 * that test runs on the JVM.
 *
 * Every field a code carries is ASCII, so walking UTF-16 units here gives the
 * answers Swift's walk over Unicode scalars gives: a non-ASCII unit fails the
 * same check a non-ASCII scalar does.
 */
data class PairingCode(
    val user: String,
    /** A host name or an IPv4 address. */
    val host: String,
    /** 0 for sshd's default port, the way `ServerRecord.port` stores it. */
    val port: Int,
    /** `SHA256:…` as `ssh-keygen -lf` prints it, one per host key. */
    val fingerprints: List<String>,
) {
    val destination: String get() = "$user@$host"

    sealed interface Read {
        data class Code(val code: PairingCode) : Read
        data class Problem(val problem: String) : Read
    }

    /** A stored server, reduced to what the pin rule reads. */
    data class Known(
        val id: String,
        val destination: String,
        val port: Int,
        /** The pinned key's `SHA256:…`, or "" for a record whose pin was dropped. */
        val fingerprint: String,
    )

    /** What the stored servers make of this code (remote.md §4b, the first rule). */
    sealed interface Match {
        /** No record for this account at this host and port. The key the server
         * offers has to be one the code names, and it is pinned. */
        data object New : Match
        /** This account's record, pinned to a key the code names. The pin
         * decides the dial, and nothing is pinned again. */
        data class Pinned(val id: String) : Match
        /** This account's record with its pin dropped. The code's key is pinned. */
        data class Unpinned(val id: String) : Match
        /** A record at this host and port is pinned to a key the code does not
         * name. The code is refused, the way a changed host key is. */
        data class Conflict(val pinned: String) : Match
    }

    /**
     * A host key belongs to a host and a port rather than to an account, so a
     * pin on any account there can refuse the code. A host name compares
     * without regard to ASCII case, since DNS ignores it.
     */
    fun match(known: List<Known>): Match {
        val host = asciiLowercased(host)
        val here = known.filter { asciiLowercased(it.destination.substringAfter('@', "")) == host && it.port == port }
        here.firstOrNull { it.fingerprint.isNotEmpty() && it.fingerprint !in fingerprints }?.let { return Match.Conflict(it.fingerprint) }
        val mine = here.firstOrNull { it.destination.substringBefore('@') == user } ?: return Match.New
        return if (mine.fingerprint.isEmpty()) Match.Unpinned(mine.id) else Match.Pinned(mine.id)
    }

    /** The first problem with the fields, checked in `pairingProblem`'s order. */
    val problem: String?
        get() = when {
            !isName(user, 64) -> Problems.USER
            !isName(host, 253) -> Problems.HOST
            port != 0 && port !in 1..65535 -> Problems.PORT
            fingerprints.isEmpty() -> Problems.NO_FINGERPRINT
            !fingerprints.all(::isFingerprint) -> Problems.FINGERPRINT
            fingerprints.toSet().size > MAX_FINGERPRINTS -> Problems.TOO_MANY_FINGERPRINTS
            else -> null
        }

    object Problems {
        const val NOT_A_CODE = "This is not a Ledge pairing code."
        const val NEWER = "This pairing code needs a newer version of Ledge. Update the app, then try the code again."
        const val VERSION = "The pairing code's version is not one Ledge recognizes."
        const val ENCODING = "The pairing code has a damaged character in it."
        const val USER = "The pairing code has no valid account name."
        const val HOST = "The pairing code has no valid host name or IP address."
        const val PORT = "The pairing code's port is not a whole number from 1 to 65535."
        const val NO_FINGERPRINT = "The pairing code has no host key fingerprint."
        const val FINGERPRINT = "The pairing code has a host key fingerprint that is not a SHA256 fingerprint."
        const val TOO_MANY_FINGERPRINTS = "The pairing code names more than $MAX_FINGERPRINTS host keys."
        fun repeated(field: String) = "The pairing code gives the $field more than once."
    }

    companion object {
        const val VERSION = 1
        const val MAX_FINGERPRINTS = 4

        fun read(text: String): Read {
            val trimmed = text.trim(' ', '\t', '\r', '\n')
            val hash = trimmed.indexOf('#')
            if (hash < 0) return Read.Problem(Problems.NOT_A_CODE)
            val base = asciiLowercased(trimmed.substring(0, hash))
            if (base != "https://ledge.sh/pair" && base != "ledge://pair") return Read.Problem(Problems.NOT_A_CODE)

            val fields = trimmed.substring(hash + 1).split('&').filter { it.isNotEmpty() }.map { segment ->
                val eq = segment.indexOf('=')
                if (eq < 0) segment to "" else segment.substring(0, eq) to segment.substring(eq + 1)
            }
            fun raws(key: String) = fields.filter { it.first == key }.map { it.second }

            val versions = raws("v")
            if (versions.isEmpty()) return Read.Problem(Problems.NOT_A_CODE)
            if (versions.size > 1) return Read.Problem(Problems.repeated("version"))
            val version = versionNumber(versions[0]) ?: return Read.Problem(Problems.VERSION)
            if (version > VERSION) return Read.Problem(Problems.NEWER)

            for ((key, name) in listOf("u" to "account name", "h" to "host", "p" to "port")) {
                if (raws(key).size > 1) return Read.Problem(Problems.repeated(name))
            }
            val decoded = HashMap<String, List<String>>()
            for (key in listOf("u", "h", "p", "k")) {
                val values = raws(key).map(::percentDecoded)
                if (values.any { it == null }) return Read.Problem(Problems.ENCODING)
                decoded[key] = values.filterNotNull()
            }

            val code = PairingCode(
                user = decoded["u"]!!.firstOrNull().orEmpty(),
                host = decoded["h"]!!.firstOrNull().orEmpty(),
                port = portField(decoded["p"]!!.firstOrNull()),
                fingerprints = decoded["k"]!!.distinct(),
            )
            return code.problem?.let { Read.Problem(it) } ?: Read.Code(code)
        }

        private const val NAME_START = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
        private const val BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        // The last of 43 base64 characters holds four bits of a 32-byte digest.
        private const val BASE64_LAST = "AEIMQUYcgkosw048"
        private const val HEX = "0123456789ABCDEFabcdef"

        /** ASCII, not starting with "-" or ".", so it cannot become an ssh option. */
        private fun isName(text: String, maxLength: Int): Boolean =
            text.isNotEmpty() && text.length <= maxLength && text[0] in NAME_START &&
                text.all { it in NAME_START || it == '.' || it == '-' }

        private fun isFingerprint(text: String): Boolean =
            text.length == 50 && text.startsWith("SHA256:") &&
                text.substring(7, 49).all { it in BASE64 } && text[49] in BASE64_LAST

        private fun versionNumber(text: String): Int? =
            if (text.length in 1..6 && text.all { it in '0'..'9' } && text[0] != '0') text.toInt() else null

        /** -1 for text that is not a port, so `problem` reports it in its turn. */
        private fun portField(text: String?): Int {
            if (text == null) return 0
            if (text.length !in 1..5 || !text.all { it in '0'..'9' }) return -1
            val port = text.toInt()
            if (port !in 1..65535) return -1
            return if (port == 22) 0 else port
        }

        /** Only escapes of ASCII bytes, like the TypeScript reader: every field
         * is ASCII, so a byte above 0x7f is damage. */
        private fun percentDecoded(raw: String): String? {
            val out = StringBuilder()
            var at = 0
            while (at < raw.length) {
                if (raw[at] != '%') {
                    out.append(raw[at])
                    at += 1
                    continue
                }
                if (at + 2 >= raw.length || raw[at + 1] !in HEX || raw[at + 2] !in HEX) return null
                val byte = raw.substring(at + 1, at + 3).toInt(16)
                if (byte > 0x7f) return null
                out.append(byte.toChar())
                at += 3
            }
            return out.toString()
        }

        private fun asciiLowercased(text: String): String =
            buildString { text.forEach { append(if (it in 'A'..'Z') it + 32 else it) } }
    }
}
