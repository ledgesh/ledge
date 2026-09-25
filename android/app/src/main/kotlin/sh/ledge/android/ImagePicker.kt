package sh.ledge.android

import android.Manifest
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import kotlin.concurrent.thread

/**
 * Where Insert Image… gets a picture on Android: the photo picker, the camera,
 * or Files. The counterpart of ios/Sources/ImagePicker.swift (ios.md §11), and
 * the same rules: a menu of the sources first, bytes only (the server names the
 * file, remote.md §2), JPEG at 90 except a PNG from Files, and every source
 * re-encoded so the picture's own EXIF, and the location in it, stays here.
 *
 * Constructed with the activity, because a result launcher must be registered
 * before the activity starts.
 */
class ImagePicker(private val host: ComponentActivity) {
    /** The pick in flight. The menu is modal, so there is never a second. */
    private var answer: ((String) -> Unit)? = null
    /** Take Photo's file, while the camera app has it. */
    private var shot: File? = null

    /** Android's photo picker, which is why the library asks no permission:
     * it runs in the system's process and hands back only what was chosen. */
    private val library = host.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        read(uri, file = false)
    }

    /** Files, for a picture that is not in the gallery: a diagram, an export. */
    private val files = host.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        read(uri, file = true)
    }

    private val camera = host.registerForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val file = shot
        shot = null
        if (!taken || file == null) {
            file?.delete()
            return@registerForActivityResult finish("")
        }
        encodeOff { runCatching { photo(ImageDecoder.createSource(file)) }.also { file.delete() }.getOrDefault("") }
    }

    /** The camera permission, which the manifest declares for the pairing
     * scanner. Declaring it is what makes the system camera refuse an app
     * that has not been granted it, so Take Photo asks first. */
    private val allowCamera = host.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            shoot()
        } else {
            Toast.makeText(host, "Take Photo needs the camera. Allow it in Settings.", Toast.LENGTH_LONG).show()
            finish("")
        }
    }

    /** Offer the sources and answer base64, or "" for a cancel at either step,
     * a non-image, or a picture that could not be read. */
    fun pick(then: (String) -> Unit) {
        answer?.invoke("")
        answer = then
        val sources = mutableListOf<Pair<String, () -> Unit>>(
            "Photos" to { library.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
        )
        // Absent rather than failing where there is no camera app to ask.
        if (Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(host.packageManager) != null) {
            sources += "Take Photo" to {
                if (host.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) shoot()
                else allowCamera.launch(Manifest.permission.CAMERA)
            }
        }
        sources += "Choose File" to { files.launch(arrayOf("image/*")) }
        AlertDialog.Builder(host)
            .setTitle("Insert Image")
            .setItems(sources.map { it.first }.toTypedArray()) { _, which -> sources[which].second() }
            .setOnCancelListener { finish("") }
            .show()
    }

    private fun shoot() {
        val dir = File(host.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "photo.jpg").apply { delete() }
        shot = file
        camera.launch(FileProvider.getUriForFile(host, "${host.packageName}.pictures", file))
    }

    private fun read(uri: Uri?, file: Boolean) {
        if (uri == null) return finish("")
        encodeOff {
            val bytes = runCatching { host.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
            if (bytes == null) "" else if (file) file(bytes) else photo(source(bytes))
        }
    }

    /** Off the main thread, because a full-size camera frame takes a visible
     * moment to decode and encode. Answered back on it. */
    private fun encodeOff(work: () -> String) {
        thread(name = "ledge-picture", isDaemon = true) {
            val base64 = runCatching(work).onFailure { Log.w("ledge", "[shell] picture failed: ${it.message}") }.getOrDefault("")
            host.runOnUiThread { finish(base64) }
        }
    }

    /** Answering twice would resolve a bridge call that is already settled. */
    private fun finish(base64: String) {
        val then = answer ?: return
        answer = null
        then(base64)
    }

    companion object {
        /** Where JPEG stops being distinguishable from the original by eye and
         * keeps being a tenth of the size. The iOS shell's quality too. */
        private const val QUALITY = 90

        /** A picture as base64 JPEG, or "" when it will not decode. The
         * decoder applies the EXIF rotation, so the picture stands the way it
         * was taken once the EXIF is gone. */
        fun photo(source: ImageDecoder.Source): String {
            val bitmap = runCatching { decode(source) }.getOrNull() ?: return ""
            return encode(bitmap, Bitmap.CompressFormat.JPEG)
        }

        /** A file's picture: a PNG stays a PNG, because a file in Files is as
         * likely to be a diagram with a transparent background as a
         * photograph, and JPEG has no transparency. */
        fun file(bytes: ByteArray): String {
            if (!bytes.startsWith(PNG)) return photo(source(bytes))
            val bitmap = runCatching { decode(source(bytes)) }.getOrNull() ?: return ""
            return encode(bitmap, Bitmap.CompressFormat.PNG)
        }

        /** The paste event's picture, re-encoded (ios.md §11). The WebView
         * read it under the user's Paste, so the page sends its bytes here
         * rather than `clipboard` below reading again. */
        fun pasted(base64: String): String {
            val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull() ?: return ""
            return photo(source(bytes))
        }

        /** The clipboard's picture as base64 JPEG, or "" when it holds none.
         * A copied image is a content URI with an image type. */
        fun clipboard(host: ComponentActivity): String {
            val clip = host.getSystemService(ClipboardManager::class.java).primaryClip ?: return ""
            if (clip.itemCount == 0 || !clip.description.hasMimeType("image/*")) return ""
            val uri = clip.getItemAt(0).uri ?: return ""
            val bytes = runCatching { host.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: return ""
            return photo(source(bytes))
        }

        /** Through a buffer: the ByteArray overload is Android 12's, and this
         * app runs on 10. */
        private fun source(bytes: ByteArray): ImageDecoder.Source = ImageDecoder.createSource(ByteBuffer.wrap(bytes))

        /** Software pixels: a hardware bitmap cannot be read back to compress. */
        private fun decode(source: ImageDecoder.Source): Bitmap =
            ImageDecoder.decodeBitmap(source) { decoder, _, _ -> decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE }

        private fun encode(bitmap: Bitmap, format: Bitmap.CompressFormat): String {
            val out = ByteArrayOutputStream()
            if (!bitmap.compress(format, QUALITY, out)) return ""
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }

        private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)

        private fun ByteArray.startsWith(prefix: ByteArray) =
            size >= prefix.size && prefix.indices.all { this[it] == prefix[it] }
    }
}
