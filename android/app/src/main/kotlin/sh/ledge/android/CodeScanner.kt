package sh.ledge.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * QR decoding for one camera frame's brightness plane. ZXing rather than ML
 * Kit, because ML Kit's scanner comes from Google Play services and a phone
 * without them is a phone this screen would refuse.
 */
object QrDecoder {
    private val hints = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
    )

    /** The text of the QR code in the frame, or null for a frame with none. */
    fun decode(luma: ByteArray, rowStride: Int, width: Int, height: Int): String? {
        val source = PlanarYUVLuminanceSource(luma, rowStride, height, 0, 0, width, height, false)
        return try {
            QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (_: ReaderException) {
            null
        }
    }
}

/**
 * The camera on a pairing code (ios.md §4): the counterpart of iOS's
 * CodeScannerViewController. Asks for the camera the first time, sends a
 * refusal to Settings, and ends on the first frame that reads as a code. A QR
 * code that is not one leaves the camera running with its problem as the hint.
 */
@Composable
fun CodeScanner(onCode: (PairingCode) -> Unit) {
    val context = LocalContext.current
    var allowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var refused by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = granted
        refused = !granted
    }
    LaunchedEffect(Unit) { if (!allowed) ask.launch(Manifest.permission.CAMERA) }

    when {
        allowed -> CameraPreview(onCode)
        refused -> Column(
            Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        ) {
            Text("Ledge needs the camera to read a pairing code. Allow it in Settings, under Permissions.")
            Button(onClick = {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                )
            }) { Text("Open Settings") }
        }
    }
}

@Composable
private fun CameraPreview(onCode: (PairingCode) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var hint by remember { mutableStateOf("Point the camera at the code ledge pair shows.") }
    var broken by remember { mutableStateOf<String?>(null) }
    val done = remember { AtomicBoolean(false) }
    val analysis = remember { Executors.newSingleThreadExecutor() }
    val preview = remember { PreviewView(context) }

    DisposableEffect(owner) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val provider = runCatching { future.get() }.getOrNull() ?: return@addListener
            val shown = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
            val frames = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            frames.setAnalyzer(analysis) { image ->
                image.use {
                    if (done.get()) return@use
                    val plane = it.planes[0]
                    val luma = ByteArray(plane.buffer.remaining()).also { bytes -> plane.buffer.get(bytes) }
                    val text = QrDecoder.decode(luma, plane.rowStride, it.width, it.height) ?: return@use
                    when (val read = PairingCode.read(text)) {
                        is PairingCode.Read.Code -> if (done.compareAndSet(false, true)) {
                            ContextCompat.getMainExecutor(context).execute { onCode(read.code) }
                        }
                        is PairingCode.Read.Problem -> ContextCompat.getMainExecutor(context).execute { hint = read.problem }
                    }
                }
            }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, shown, frames)
            } catch (error: Exception) {
                Log.w("ledge", "[scan] no camera: ${error.message}")
                broken = "This device has no camera Ledge can read a code with."
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            runCatching { future.get().unbindAll() }
            analysis.shutdown()
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView({ preview }, Modifier.fillMaxSize())
        Text(
            broken ?: hint,
            color = Color.White,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.6f))
                .padding(20.dp),
        )
    }
}
