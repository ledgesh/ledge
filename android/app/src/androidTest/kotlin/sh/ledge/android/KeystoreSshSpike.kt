package sh.ledge.android

import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hierynomus.sshj.key.KeyAlgorithms
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.signature.Signature
import net.schmizz.sshj.signature.SignatureECDSA
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.method.AuthPublickey
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Security
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.TimeUnit

// The chunk 1 spike: can a P-256 key that lives in the Android Keystore
// authenticate an ssh connection through sshj? Two phases, run separately by
// the driver so the fixture can be given the key between them: `mint` makes
// the key (once) and reports its authorized_keys line, and `dial` connects to
// the fixture with it, pinned to the host key the driver passes in.
@RunWith(AndroidJUnit4::class)
class KeystoreSshSpike {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val args = InstrumentationRegistry.getArguments()

    private fun report(key: String, value: String) {
        instrumentation.sendStatus(0, Bundle().apply { putString(key, value) })
    }

    private fun keystore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun deviceKey(): Pair<PrivateKey, PublicKey> {
        val ks = keystore()
        if (!ks.containsAlias(ALIAS)) {
            val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            gen.initialize(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build(),
            )
            gen.generateKeyPair()
        }
        val entry = ks.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
        return entry.privateKey to entry.certificate.publicKey
    }

    private fun publicLine(pub: PublicKey): String {
        val blob = Buffer.PlainBuffer().putPublicKey(pub).compactData
        return "${KeyType.fromKey(pub)} ${Base64.encodeToString(blob, Base64.NO_WRAP)}"
    }

    @Test
    fun mint() {
        val (priv, pub) = deviceKey()
        val info = KeyFactory.getInstance(priv.algorithm, "AndroidKeyStore").getKeySpec(priv, KeyInfo::class.java)
        report("security", info.securityLevel.toString())
        report("encoded", (priv.encoded == null).let { if (it) "null" else "present" })
        report("pubkey", publicLine(pub))
    }

    @Test
    fun dial() {
        val host = args.getString("host") ?: "10.0.2.2"
        val port = args.getString("port")?.toInt() ?: 2222
        val pin = Base64.decode(args.getString("hostkey")!!.trim().split(Regex("\\s+"))[1], Base64.DEFAULT)
        val (priv, pub) = deviceKey()

        // sshj asks for "BC" by name, and on Android that name is the
        // platform's cut-down copy, which has no X25519. The full one replaces
        // it. The platform's own providers cannot stand in: every ephemeral key
        // lookup lands on the Keystore's provider, which refuses plain specs.
        Security.removeProvider("BC")
        Security.addProvider(BouncyCastleProvider())
        SecurityUtils.setSecurityProvider("BC")

        // BouncyCastle cannot sign with a Keystore key, which has no encoding,
        // so ecdsa-sha2-nistp256 signs through the platform's own lookup.
        val config = DefaultConfig()
        config.keyAlgorithms = config.keyAlgorithms.map {
            if (it.name == KeyType.ECDSA256.toString()) KeyAlgorithms.Factory(it.name, KeystoreEcdsa.Factory, KeyType.ECDSA256) else it
        }
        val ssh = SSHClient(config)
        ssh.addHostKeyVerifier(object : HostKeyVerifier {
            override fun verify(hostname: String, port: Int, key: PublicKey): Boolean =
                Buffer.PlainBuffer().putPublicKey(key).compactData.contentEquals(pin)

            override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = listOf("ssh-ed25519")
        })
        ssh.connectTimeout = 10_000
        ssh.connect(host, port)
        report("connected", ssh.transport.serverVersion)

        ssh.auth("ledge", AuthPublickey(object : KeyProvider {
            override fun getPrivate() = priv
            override fun getPublic() = pub
            override fun getType() = KeyType.fromKey(pub)
        }))
        report("authenticated", ssh.isAuthenticated.toString())

        // Ask for `whoami`: the forced command runs `ledge serve` regardless,
        // which is the proof the key reached the restricted door.
        ssh.startSession().use { session ->
            val cmd = session.exec("whoami")
            val err = StringBuilder()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            val buf = ByteArray(4096)
            while (!err.contains("attached to") && System.nanoTime() < deadline) {
                if (cmd.errorStream.available() > 0) {
                    val n = cmd.errorStream.read(buf)
                    if (n < 0) break
                    err.append(String(buf, 0, n))
                } else {
                    Thread.sleep(50)
                }
            }
            var out = ByteArray(0)
            val outDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (out.isEmpty() && System.nanoTime() < outDeadline) {
                val n = cmd.inputStream.available()
                if (n > 0) out = ByteArray(n).also { cmd.inputStream.read(it) } else Thread.sleep(50)
            }
            report("stderr", err.lineSequence().firstOrNull().orEmpty())
            report("stdout", String(out, Charsets.ISO_8859_1).filter { it in ' '..'~' }.take(120))
            assertTrue("serve attached", err.contains("[serve] ledge") && err.contains("attached to"))
            assertFalse("whoami did not run", String(out).trim() == "ledge")
        }
        ssh.disconnect()
    }

    private companion object {
        const val ALIAS = "ledge-device-key"
    }
}

// ecdsa-sha2-nistp256 with signing through the platform's own lookup rather
// than sshj's named provider. Encoding the DER signature for the wire and
// verifying a peer's signature stay sshj's.
private class KeystoreEcdsa : Signature {
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
