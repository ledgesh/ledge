package sh.ledge.android

import android.util.Base64
import com.hierynomus.sshj.key.KeyAlgorithms
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.DisconnectReason
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.connection.ConnectionException
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.method.AuthPublickey
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Security
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * One ssh connection whose exec channel is the page's byte stream: the
 * counterpart of ios/Sources/SSHTransport.swift, over sshj.
 *
 * Nothing here parses a frame. Bytes from the page go down the channel's stdin
 * and bytes off its stdout go up (ios.md §2). The server's stderr is only
 * logged.
 */
class SshTransport(
    /** Which `@open` this answers, for the page to drop a superseded socket's
     * bytes (nativeBridge.ts). */
    val generation: Int,
    private val server: ServerRecord,
    private val key: DeviceKey.Held,
    private val log: (String) -> Unit,
) {
    // Dialling, then writes, in order, off the main thread: a write blocks
    // while the channel's window is full.
    private val io = Executors.newSingleThreadExecutor()
    private var ssh: SSHClient? = null
    private var command: Session.Command? = null
    @Volatile private var closed = false

    fun open(ready: (Result<Unit>) -> Unit, bytes: (ByteArray) -> Unit, end: () -> Unit) {
        io.execute {
            val client = SSHClient(CONFIG)
            ssh = client
            // A server that accepts TCP and then says nothing looks like a slow
            // one, and the page's reconnect ladder waits on this. The watchdog
            // bounds the whole dial rather than each step of it.
            val settled = AtomicBoolean(false)
            val timedOut = AtomicBoolean(false)
            val watchdog = TIMER.schedule({
                if (!settled.get()) {
                    timedOut.set(true)
                    runCatching { client.disconnect() }
                }
            }, DIAL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            try {
                val (user, host) = server.userAndHost()
                client.addHostKeyVerifier(PinnedHostKey(server.hostKey))
                client.connectTimeout = DIAL_TIMEOUT_MS.toInt()
                client.transport.timeoutMs = DIAL_TIMEOUT_MS.toInt()
                client.connect(host, server.portOrDefault)
                client.auth(user, AuthPublickey(object : KeyProvider {
                    override fun getPrivate() = key.private
                    override fun getPublic() = key.public
                    override fun getType() = KeyType.fromKey(key.public)
                }))
                val session = client.startSession()
                val running = session.exec(SERVE_COMMAND)
                command = running
                settled.set(true)
                watchdog.cancel(false)
                if (closed) return@execute client.close()
                ready(Result.success(Unit))
                pump(running, bytes, end)
            } catch (error: Throwable) {
                settled.set(true)
                watchdog.cancel(false)
                runCatching { client.close() }
                val why = if (timedOut.get()) "${server.hostOnly()} did not answer within ${DIAL_TIMEOUT_MS / 1000} seconds." else describe(error)
                log("[ssh] dial failed: $why (${error.javaClass.simpleName}: ${error.message})")
                ready(Result.failure(SshFailure(why, needsPairing(error))))
            }
        }
    }

    private fun pump(running: Session.Command, bytes: (ByteArray) -> Unit, end: () -> Unit) {
        thread(name = "ledge-ssh-out-$generation", isDaemon = true) {
            val buf = ByteArray(64 * 1024)
            try {
                while (true) {
                    val n = running.inputStream.read(buf)
                    if (n < 0) break
                    if (n > 0) bytes(buf.copyOf(n))
                }
            } catch (_: IOException) {
                // The connection went; `end` says so either way.
            }
            if (!closed) {
                log("[ssh] the channel closed")
                end()
            }
            close()
        }
        thread(name = "ledge-ssh-err-$generation", isDaemon = true) {
            runCatching {
                running.errorStream.bufferedReader().forEachLine { log("[server] $it") }
            }
        }
    }

    fun send(bytes: ByteArray) {
        if (closed) return
        io.execute {
            try {
                command?.outputStream?.apply {
                    write(bytes)
                    flush()
                }
            } catch (error: IOException) {
                // The read side notices the same failure and reports the end.
                log("[ssh] write failed: ${error.message}")
            }
        }
    }

    fun close() {
        if (closed) return
        closed = true
        io.execute {
            runCatching { command?.close() }
            runCatching { ssh?.disconnect() }
        }
        io.shutdown()
    }

    private fun describe(error: Throwable): String {
        val host = server.hostOnly()
        return when {
            error is SshFailure -> error.message ?: ""
            error is UserAuthException -> "$host refused this device's key. Install its line in that account's authorized_keys."
            error is TransportException && error.disconnectReason == DisconnectReason.HOST_KEY_NOT_VERIFIABLE ->
                "$host offered a different host key from the one this device pinned."
            error is ConnectionException -> "The server refused to run the Ledge command."
            error is UnknownHostException -> "There is no host called $host."
            error is ConnectException || error is NoRouteToHostException || error is SocketTimeoutException ->
                "Could not reach $host on port ${server.portOrDefault}."
            else -> error.message ?: error.javaClass.simpleName
        }
    }

    /** Whether retrying cannot help, and only pairing again can. */
    private fun needsPairing(error: Throwable): Boolean =
        error is UserAuthException ||
            (error is TransportException && error.disconnectReason == DisconnectReason.HOST_KEY_NOT_VERIFIABLE)

    companion object {
        /** `SERVE_COMMAND` in shared/connections.ts, character for character. */
        const val SERVE_COMMAND = "PATH=\$HOME/.ledge/.server/bin:\$PATH ledge serve"
        const val DEFAULT_PORT = 22
        private const val DIAL_TIMEOUT_MS = 15_000L

        private val TIMER = Executors.newSingleThreadScheduledExecutor()

        /**
         * sshj asks for "BC" by name, and on Android that name is the
         * platform's cut-down copy, which has no X25519. The full one replaces
         * it. The platform's own providers cannot stand in: every ephemeral
         * key lookup lands on the Keystore's provider, which refuses plain
         * specs. And ecdsa-sha2-nistp256 signs through [KeystoreEcdsa].
         */
        private val CONFIG: DefaultConfig by lazy {
            Security.removeProvider("BC")
            Security.addProvider(BouncyCastleProvider())
            SecurityUtils.setSecurityProvider("BC")
            DefaultConfig().apply {
                keyAlgorithms = keyAlgorithms.map {
                    if (it.name == KeyType.ECDSA256.toString()) KeyAlgorithms.Factory(it.name, KeystoreEcdsa.Factory, KeyType.ECDSA256) else it
                }
            }
        }

        /**
         * Ask a host for its key and hang up, for `connectionProbe`: the job
         * `ssh-keyscan` does on a Mac. Only as far as key exchange, so this
         * device's key never goes on the wire. Blocks; call it off the main
         * thread.
         */
        fun probe(destination: String, port: Int): HostKeyOffer {
            val host = destination.substringAfterLast('@')
            var offered: String? = null
            val client = SSHClient(CONFIG)
            client.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
                    offered = openSSHLine(key)
                    return false
                }

                override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
            })
            client.connectTimeout = DIAL_TIMEOUT_MS.toInt()
            client.transport.timeoutMs = DIAL_TIMEOUT_MS.toInt()
            val failure = runCatching { client.connect(host, if (port > 0) port else DEFAULT_PORT) }.exceptionOrNull()
            runCatching { client.close() }
            // The refusal is the success: a captured offer means the handshake
            // got far enough to ask.
            offered?.let { return HostKeyOffer(it, fingerprint(it), it.substringBefore(' '), "") }
            val why = when (failure) {
                is UnknownHostException -> "There is no host called $host."
                null -> "$host did not offer a host key."
                else -> "Could not reach $host on port ${if (port > 0) port else DEFAULT_PORT}."
            }
            return HostKeyOffer("", "", "", why)
        }

        fun openSSHLine(key: PublicKey): String {
            val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
            return "${KeyType.fromKey(key)} ${Base64.encodeToString(blob, Base64.NO_WRAP)}"
        }

        /** OpenSSH's `SHA256:` form, as `ssh-keygen -l` prints it. */
        fun fingerprint(line: String): String {
            val blob = Base64.decode(line.trim().split(Regex("\\s+"))[1], Base64.DEFAULT)
            val digest = MessageDigest.getInstance("SHA-256").digest(blob)
            return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
        }
    }
}

class SshFailure(message: String, val needsPairing: Boolean) : Exception(message)

class HostKeyOffer(val hostKey: String, val fingerprint: String, val keyType: String, val error: String)

/**
 * The pinned case, always: the running app never trusts a new key, since that
 * question belongs to pairing, where a person is looking at the screen. The
 * pin is the key's two fields, compared as bytes.
 */
private class PinnedHostKey(line: String) : HostKeyVerifier {
    private val fields = line.trim().split(Regex("\\s+"))
    private val type = fields.getOrNull(0).orEmpty()
    private val blob = fields.getOrNull(1)?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() }

    override fun verify(hostname: String, port: Int, key: PublicKey): Boolean =
        blob != null && Buffer.PlainBuffer().putPublicKey(key).compactData.contentEquals(blob)

    // Steers key exchange to the algorithm of the pinned key, so a host with
    // several offers the one this device can check.
    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> =
        if (type.isEmpty()) emptyList() else listOf(type)
}
