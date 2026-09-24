package sh.ledge.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.signature.Signature
import net.schmizz.sshj.signature.SignatureECDSA
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec

/**
 * This device's one ssh key: P-256 in the Android Keystore, the counterpart of
 * the iPhone's Secure Enclave key (ios.md §4). Minted on first use and never
 * exported. `getEncoded()` on the private half is null, which is why signing
 * goes through [KeystoreEcdsa].
 */
object DeviceKey {
    private const val ALIAS = "ledge-device-key"

    class Held(val private: PrivateKey, val public: PublicKey) {
        /** The public half as `authorized_keys` wants it: type and base64. */
        val openSSHPublicKey: String
            get() {
                val blob = Buffer.PlainBuffer().putPublicKey(public).compactData
                return "${KeyType.fromKey(public)} ${Base64.encodeToString(blob, Base64.NO_WRAP)}"
            }
    }

    fun load(): Held {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(ALIAS)) mint()
        val entry = store.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
        return Held(entry.privateKey, entry.certificate.publicKey)
    }

    /**
     * StrongBox where the phone has one, the TEE where it does not. The
     * emulator has neither and keeps the key in software.
     */
    private fun mint() {
        try {
            generate(strongBox = true)
        } catch (_: StrongBoxUnavailableException) {
            generate(strongBox = false)
        }
    }

    private fun generate(strongBox: Boolean) {
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        gen.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setIsStrongBoxBacked(strongBox)
                .build(),
        )
        gen.generateKeyPair()
        Log.i("ledge", "[shell] minted the device key${if (strongBox) " in StrongBox" else ""}")
    }

    /** The line a server installs, restricted to the serve command, with a
     * comment saying which device it is for when there are several. The iOS
     * shape (ios/Sources/DeviceKey.swift). */
    fun authorizedKeysLine(held: Held, client: String): String =
        "restrict,command=\"${SshTransport.SERVE_COMMAND}\" ${held.openSSHPublicKey} ledge-android-${client.take(8).lowercase()}"

    /** shared/connections.ts `authorizeCommand`, checked by
     * shared/authorizeCommand.test.ts: the line appended to authorized_keys,
     * with `~/.ssh` and the file made at the modes sshd insists on. */
    const val AUTHORIZE_PREFIX = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '\\n%s\\n' "
    const val AUTHORIZE_SUFFIX = " >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

    fun authorizeCommand(line: String): String = AUTHORIZE_PREFIX + "'" + line.replace("'", "'\\''") + "'" + AUTHORIZE_SUFFIX

    /** Where the key is kept and its line, on the log, so a probe reads the
     * line at first launch without a screen (testing.md §6). */
    fun log(held: Held, client: String) {
        Log.i("ledge", "[pair] ${authorizedKeysLine(held, client)}")
    }
}

/**
 * ecdsa-sha2-nistp256 with signing through the platform's own provider lookup
 * rather than sshj's named one. BouncyCastle cannot sign with a Keystore key,
 * which has no encoding. A provider-less `getInstance` defers the choice to
 * `initSign`, where the Keystore's provider takes its own key. Encoding the
 * signature for the wire and verifying a peer's stay sshj's.
 */
class KeystoreEcdsa : Signature {
    private val sshj = SignatureECDSA("SHA256withECDSA", KeyType.ECDSA256.toString())
    private val engine = java.security.Signature.getInstance("SHA256withECDSA")
    private var signing = false

    override fun getSignatureName() = KeyType.ECDSA256.toString()

    override fun initVerify(pubkey: PublicKey) {
        signing = false
        sshj.initVerify(pubkey)
    }

    override fun initSign(prvkey: PrivateKey) {
        signing = true
        engine.initSign(prvkey)
    }

    override fun update(H: ByteArray) = update(H, 0, H.size)

    override fun update(H: ByteArray, off: Int, len: Int) {
        if (signing) engine.update(H, off, len) else sshj.update(H, off, len)
    }

    override fun sign(): ByteArray = engine.sign()

    override fun encode(signature: ByteArray): ByteArray = sshj.encode(signature)

    override fun verify(sig: ByteArray) = sshj.verify(sig)

    object Factory : net.schmizz.sshj.common.Factory.Named<Signature> {
        override fun create(): Signature = KeystoreEcdsa()

        override fun getName() = KeyType.ECDSA256.toString()
    }
}
