package sh.ledge.android

import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import java.security.MessageDigest
import java.security.PublicKey
import java.util.Base64
import java.util.concurrent.CountDownLatch

/**
 * A host key as a person reads it and as a pin stores it: the counterpart of
 * ios/Sources/HostKey.swift, whose comment says why a phone decides about the
 * key itself (ios.md §3). The decision stays a byte comparison. The
 * fingerprint decides one thing: which key a pairing code lets the phone pin.
 */
class HostKeyOffer(
    /** `ssh-ed25519 AAAAC3…`, the two fields that identify a key. */
    val line: String,
) {
    /** `SHA256:…`, exactly what `ssh-keygen -lf` prints. */
    val fingerprint: String = fingerprint(line)
    val keyType: String get() = line.substringBefore(' ')

    companion object {
        fun of(key: PublicKey) = HostKeyOffer(openSSHLine(key))

        fun openSSHLine(key: PublicKey): String {
            val blob = Buffer.PlainBuffer().putPublicKey(key).compactData
            return "${KeyType.fromKey(key)} ${Base64.getEncoder().encodeToString(blob)}"
        }

        fun fingerprint(line: String): String {
            val blob = line.trim().split(Regex("\\s+")).getOrNull(1)
                ?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: return ""
            val digest = MessageDigest.getInstance("SHA-256").digest(blob)
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
        }
    }
}

/**
 * One way of judging the offered key, and what it concluded. sshj reports a
 * refused key as HOST_KEY_NOT_VERIFIABLE and nothing more, so the sentence a
 * person needs, with both fingerprints in it, is kept here for
 * SshTransport's `describe`.
 */
abstract class HostKeyJudge : HostKeyVerifier {
    @Volatile var refusal: String? = null
        protected set
    /** The key this judge let through, for the caller to pin once the rest of
     * the connection has proven the pairing works. */
    @Volatile var accepted: HostKeyOffer? = null
        protected set

    final override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        val offered = HostKeyOffer.of(key)
        val why = judge(offered)
        if (why == null) accepted = offered else refusal = why
        return why == null
    }

    /** Null to accept, or the sentence that refuses. */
    protected abstract fun judge(offered: HostKeyOffer): String?

    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}

/**
 * The pinned case: what every connection after pairing uses. The running app
 * never trusts a new key, since that question belongs to pairing, where a
 * person is looking at the screen.
 */
class PinnedHostKey(line: String) : HostKeyJudge() {
    private val expected = HostKeyOffer(line.trim().split(Regex("\\s+")).take(2).joinToString(" "))

    // Both fingerprints, because the question a user has to answer is whether
    // the new one is the server's, and only reading it answers that.
    override fun judge(offered: HostKeyOffer): String? =
        if (offered.line == expected.line) null
        else "This server offered a different host key than the one Ledge pinned when you paired.\n" +
            "Pinned: ${expected.fingerprint}\nOffered: ${offered.fingerprint}"

    // Steers key exchange to the algorithm of the pinned key, so a host with
    // several offers the one this device can check.
    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> =
        listOf(expected.keyType).filter { it.isNotEmpty() }
}

/** The probe case: take the key on offer and go no further. The refusal is
 * the point, and the answer is read off `offered`. */
class CapturingHostKey : HostKeyJudge() {
    @Volatile var offered: HostKeyOffer? = null
        private set

    override fun judge(offered: HostKeyOffer): String {
        this.offered = offered
        return "The host key was not accepted."
    }
}

/** The pairing code case: accept a key the code names and refuse any other
 * without asking. The person already read the code's fingerprints on the
 * pairing screen (remote.md §4b). */
class CodeHostKey(private val fingerprints: List<String>) : HostKeyJudge() {
    override fun judge(offered: HostKeyOffer): String? =
        if (offered.fingerprint in fingerprints) null
        else "This server offered a host key that is not in the pairing code, so Ledge did not sign in.\n" +
            "Offered: ${offered.fingerprint}\nIn the code: ${fingerprints.joinToString("\n")}"
}

/**
 * The typed pairing case: ask, and let the handshake wait for the answer. The
 * key on screen is the key of the connection in progress, and that connection
 * continues only if the person holding the phone says so. sshj asks on its
 * reader thread, which blocks here until `ask` answers, so a screen that
 * goes away while asking has to answer no.
 */
class ConfirmingHostKey(private val ask: (HostKeyOffer, (Boolean) -> Unit) -> Unit) : HostKeyJudge() {
    override fun judge(offered: HostKeyOffer): String? {
        val answered = CountDownLatch(1)
        var yes = false
        ask(offered) {
            yes = it
            answered.countDown()
        }
        answered.await()
        return if (yes) null else "The host key was not accepted."
    }
}
