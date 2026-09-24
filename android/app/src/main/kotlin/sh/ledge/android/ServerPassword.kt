package sh.ledge.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * One server's password, on this phone (remote.md §4): the counterpart of
 * ios/Sources/ServerPassword.swift.
 *
 * Android has no keychain for an app's secrets, so each password is sealed
 * with AES-GCM under a key in the Android Keystore, and only the sealed bytes
 * are in the app's preferences. The key cannot leave the Keystore, and the
 * preferences are the app's alone. Neither is backed up (the manifest's
 * allowBackup), for iOS's `ThisDeviceOnly` reasons.
 *
 * Read at dial time and held for the handshake, so a stored password is not
 * sitting in this process between connections.
 */
class ServerPassword(context: Context) {
    private val prefs = context.getSharedPreferences("ledge-passwords", Context.MODE_PRIVATE)

    /** The password for a server, or null when it has none or it cannot be
     * opened, which is the same answer to a dial: no password to offer. */
    fun read(id: String): String? {
        val sealed = prefs.getString(id, null) ?: return null
        return runCatching {
            val bytes = Base64.getDecoder().decode(sealed)
            val cipher = Cipher.getInstance(CIPHER)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
            String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
        }.onFailure { Log.w("ledge", "[shell] a stored password would not open: ${it.message}") }.getOrNull()
    }

    /** Store one, replacing whatever was there. False when the Keystore refused. */
    fun write(id: String, password: String): Boolean {
        if (id.isEmpty()) return false
        return runCatching {
            val cipher = Cipher.getInstance(CIPHER)
            // The Keystore picks the nonce: a caller-chosen one is refused.
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val sealed = cipher.iv + cipher.doFinal(password.toByteArray(Charsets.UTF_8))
            prefs.edit().putString(id, Base64.getEncoder().encodeToString(sealed)).commit()
        }.onFailure { Log.w("ledge", "[shell] the Keystore would not seal a password: ${it.message}") }.getOrDefault(false)
    }

    /** Drop it, if there is one. */
    fun forget(id: String) {
        prefs.edit().remove(id).apply()
    }

    /**
     * Every id that is not in `keep` loses its password. The page hands the
     * whole list back on every change, so this is where a removal takes the
     * credential with it: a record can leave the list in more ways than one,
     * and only the survivors are knowable here.
     */
    fun keepOnly(keep: Collection<String>) {
        val gone = prefs.all.keys.filter { it !in keep }
        if (gone.isNotEmpty()) prefs.edit().apply { gone.forEach(::remove) }.apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val ALIAS = "ledge-server-passwords"
        const val CIPHER = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
