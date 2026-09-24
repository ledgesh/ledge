package sh.ledge.android

import com.hierynomus.sshj.key.KeyAlgorithms
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.DisconnectReason
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.connection.ConnectionException
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.method.AuthKeyboardInteractive
import net.schmizz.sshj.userauth.method.AuthPassword
import net.schmizz.sshj.userauth.method.AuthPublickey
import net.schmizz.sshj.userauth.method.PasswordResponseProvider
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.Resource
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.Security
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
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
     * bytes (nativeBridge.ts). Pairing's dials are 0. */
    val generation: Int,
    private val server: ServerRecord,
    private val key: DeviceKey.Held,
    /** How the offered host key is judged: the pin on every page dial, and
     * the code or a person at pairing (HostKeys.kt). */
    private val hostKey: HostKeyJudge,
    /** The door: a string offers it, null offers the device key. Passed in
     * rather than read here, because pairing dials a record that has no id yet
     * to look one up by (ServerPassword.kt). */
    private val password: String? = null,
    private val log: (String) -> Unit,
    /** The bound on the whole dial. Pairing's typed form lengthens it, since
     * its handshake waits on a person reading a fingerprint. */
    private val dialTimeoutMs: Long = DIAL_TIMEOUT_MS,
) {
    // Dialling, then writes, in order, off the main thread: a write blocks
    // while the channel's window is full.
    private val io = Executors.newSingleThreadExecutor()
    private var ssh: SSHClient? = null
    private var command: Session.Command? = null
    @Volatile private var closed = false
    /** The exit status and last stderr line of a command that ended before
     * writing a byte of stdout. Null for one that answered. */
    @Volatile private var unanswered: Pair<Int, String>? = null

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
            }, dialTimeoutMs, TimeUnit.MILLISECONDS)
            try {
                val (user, host) = server.userAndHost()
                client.addHostKeyVerifier(hostKey)
                client.connectTimeout = DIAL_TIMEOUT_MS.toInt()
                client.transport.timeoutMs = dialTimeoutMs.toInt()
                client.connect(host, server.portOrDefault)
                if (password != null) {
                    // Offered once, never retried: a refused password is
                    // refused, and offering it again spends the server's
                    // MaxAuthTries proving it. Keyboard-interactive as well,
                    // which is how many servers ask for a password.
                    val once = object : PasswordFinder {
                        override fun reqPassword(resource: Resource<*>?) = password.toCharArray()
                        override fun shouldRetry(resource: Resource<*>?) = false
                    }
                    client.auth(user, AuthPassword(once), AuthKeyboardInteractive(PasswordResponseProvider(once)))
                } else {
                    client.auth(user, AuthPublickey(object : KeyProvider {
                        override fun getPrivate() = key.private
                        override fun getPublic() = key.public
                        override fun getType() = KeyType.fromKey(key.public)
                    }))
                }
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
                val why = if (timedOut.get()) "${server.hostOnly()} did not answer within ${dialTimeoutMs / 1000} seconds." else describe(error)
                log("[ssh] dial failed: $why (${error.javaClass.simpleName}: ${error.message})")
                ready(Result.failure(SshFailure(why, needsPairing(error))))
            }
        }
    }

    private fun pump(running: Session.Command, bytes: (ByteArray) -> Unit, end: () -> Unit) {
        val said = AtomicReference("")
        val errors = thread(name = "ledge-ssh-err-$generation", isDaemon = true) {
            runCatching {
                running.errorStream.bufferedReader().forEachLine {
                    log("[server] $it")
                    if (it.isNotBlank()) said.set(it.trim())
                }
            }
        }
        thread(name = "ledge-ssh-out-$generation", isDaemon = true) {
            val buf = ByteArray(64 * 1024)
            var answered = false
            try {
                while (true) {
                    val n = running.inputStream.read(buf)
                    if (n < 0) break
                    if (n > 0) {
                        answered = true
                        bytes(buf.copyOf(n))
                    }
                }
            } catch (_: IOException) {
                // The connection went; `end` says so either way.
            }
            // A command that ended without a byte of stdout is a shell with no
            // server behind it, and its status and last word are the diagnosis
            // (`whyUnanswered`). sshd can send the EOF before the status.
            if (!answered) {
                runCatching { running.join(2, TimeUnit.SECONDS) }
                errors.join(500)
                running.exitStatus?.let { status ->
                    log("[ssh] the server command exited $status")
                    unanswered = status to said.get()
                }
            }
            if (!closed) {
                log("[ssh] the channel closed")
                end()
            }
            close()
        }
    }

    /** Why the command ended without the server answering, once the
     * connection has ended. 127 is a shell that found no `ledge` on the PATH
     * SERVE_COMMAND gives it. Null for a server that answered. */
    fun whyUnanswered(): String? {
        val (status, said) = unanswered ?: return null
        val where = server.destination
        return when {
            status == 127 -> "Ledge's server is not installed on $where. Install it there, then try again."
            said.isEmpty() -> "$where closed the connection before Ledge's server answered."
            else -> "$where closed the connection before Ledge's server answered: $said"
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
            error is UserAuthException && password != null ->
                // Both halves, because from here they are indistinguishable.
                "${server.destination} refused that password. Check it, and that the server allows signing in with a password at all."
            error is UserAuthException ->
                "${server.destination} refused this device's key. Run the pairing screen's command there, signed in as the account Ledge uses."
            error is TransportException && error.disconnectReason == DisconnectReason.HOST_KEY_NOT_VERIFIABLE ->
                hostKey.refusal ?: "$host offered a host key Ledge did not accept."
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
        const val DIAL_TIMEOUT_MS = 15_000L

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
            val capture = CapturingHostKey()
            val client = SSHClient(CONFIG)
            client.addHostKeyVerifier(capture)
            client.connectTimeout = DIAL_TIMEOUT_MS.toInt()
            client.transport.timeoutMs = DIAL_TIMEOUT_MS.toInt()
            val failure = runCatching { client.connect(host, if (port > 0) port else DEFAULT_PORT) }.exceptionOrNull()
            runCatching { client.close() }
            // The refusal is the success: a captured offer means the handshake
            // got far enough to ask.
            capture.offered?.let { return it }
            throw SshFailure(
                when (failure) {
                    is UnknownHostException -> "There is no host called $host."
                    null -> "$host did not offer a host key."
                    else -> "Could not reach $host on port ${if (port > 0) port else DEFAULT_PORT}."
                },
                needsPairing = false,
            )
        }
    }
}

class SshFailure(message: String, val needsPairing: Boolean) : Exception(message)
