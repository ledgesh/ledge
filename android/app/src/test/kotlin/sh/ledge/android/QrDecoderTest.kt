package sh.ledge.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The decoder on a frame shaped like a camera's brightness plane: a row
 * stride wider than the image, and the code off centre. */
class QrDecoderTest {
    private val link = "ledge://pair#v=1&u=dan&h=atlas.example.net&p=2222&k=SHA256:TC7eh5uTmsVcxQYnqmYU91fK88ypYrcXOZYJ2Je8i7w"

    private fun frame(text: String?, width: Int = 640, height: Int = 480, stride: Int = 704): ByteArray {
        val luma = ByteArray(stride * height) { 0xE0.toByte() }
        if (text == null) return luma
        val code = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 300, 300)
        for (y in 0 until code.height) for (x in 0 until code.width) {
            if (code[x, y]) luma[(y + 90) * stride + x + 200] = 0x10
        }
        return luma
    }

    @Test
    fun readsAPairingLinkOutOfAFrame() {
        val text = QrDecoder.decode(frame(link), 704, 640, 480)
        assertEquals(link, text)
        assertEquals(PairingCode.Read.Code(PairingCode("dan", "atlas.example.net", 2222, listOf("SHA256:TC7eh5uTmsVcxQYnqmYU91fK88ypYrcXOZYJ2Je8i7w"))), PairingCode.read(text!!))
    }

    @Test
    fun answersNullForAFrameWithNoCode() {
        assertNull(QrDecoder.decode(frame(null), 704, 640, 480))
    }
}
