package sh.ledge.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The window, the web view, and the bridge between them and the socket: the
 * counterpart of ios/Sources/WebHost.swift.
 *
 * No frame is parsed here and no method name is understood except the calls in
 * `SHELL_CALLS` (mainview/lib/nativeBridge.ts). A frame arrives from the page
 * as base64 and goes down the socket as bytes; bytes off the socket go up as
 * base64. The page's side of this port is `attachShell`.
 */
class WebHost : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var store: ServerStore
    /** Where replies go: the page's port, handed over with its first call. */
    private var page: JavaScriptReplyProxy? = null

    private var socket: SshTransport? = null
    private var generation = 0
    /** While the activity is off screen a dial is refused, as on iOS (ios.md
     * §5): a ladder that climbs in the background hands back a socket the
     * system may freeze a moment later. */
    private var away = false
    private var leftAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        adoptLaunchServer(intent)

        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        // Chrome's inspector against a debug build. A release is not
        // inspectable: that would be a console on the user's notes.
        WebView.setWebContentsDebuggingEnabled(debuggable)

        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        // The page is a full-height app, not a document.
        web.overScrollMode = View.OVER_SCROLL_NEVER

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            // The page never navigates away from itself. A link goes out through
            // `link.open` and its scheme check; anything else is refused here.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != ORIGIN_HOST

            // The renderer was killed, which the system does under memory
            // pressure. The socket belonged to a page that no longer exists, so
            // it goes too, and the page boots again.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "[shell] the renderer went (crashed=${detail.didCrash()}); reloading")
                dropSocket()
                page = null
                view.loadUrl(ENTRY)
                return true
            }
        }
        // The webview's console goes nowhere by default.
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.i(TAG, "[console] ${message.message()} (${message.sourceId().substringAfterLast('/')}:${message.lineNumber()})")
                return true
            }
        }

        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            "this WebView has no WebMessageListener; update Android System WebView"
        }
        // Only the app's own origin gets the port. A page on any other origin
        // cannot load here (above), and would find no `ledge` if it did.
        WebViewCompat.addWebMessageListener(web, "ledge", setOf(ORIGIN)) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            page = reply
            message.data?.let(::received)
        }

        // Edge to edge is the default from Android 15, so the system bars and
        // the keyboard are this view's to stay clear of. Padding the web view
        // by all three keeps the page's own layout what it is on iOS: a full
        // screen that shrinks while the keyboard is up (ios.md §7).
        ViewCompat.setOnApplyWindowInsetsListener(web) { view, insets ->
            val clear = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(clear.left, clear.top, clear.right, clear.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(web)

        val server = store.selected()
        Log.i(TAG, "[shell] ledge -> ${server?.destination ?: "no server"}, client ${store.client}, as \"${ServerStore.label(this)}\"")
        // So the line to install is in the log before there is a screen to
        // show it on.
        runCatching { DeviceKey.load() }
            .onSuccess { Log.i(TAG, "[pair] ${DeviceKey.authorizedKeysLine(it, store.client)}") }
            .onFailure { Log.e(TAG, "[shell] no device key: ${it.message}") }
        web.loadUrl(ENTRY)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (adoptLaunchServer(intent)) {
            dropSocket()
            web.loadUrl(ENTRY)
        }
    }

    /**
     * A debug build takes its server from the launch, as `bun run android --
     * --server` passes it. Never a release: any app can start this activity
     * with extras, and a pin arriving that way would point this phone at a
     * server of that app's choosing.
     */
    private fun adoptLaunchServer(intent: Intent?): Boolean {
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return false
        val destination = intent?.getStringExtra("server") ?: return false
        val hostKey = intent.getStringExtra("hostkey").orEmpty()
        val port = intent.getStringExtra("port")?.toIntOrNull() ?: 0
        store.adopt(destination, port, hostKey)
        return true
    }

    // --- the lifecycle (ios.md §5) ---------------------------------------------

    override fun onPause() {
        super.onPause()
        away = true
        leftAt = SystemClock.elapsedRealtime()
    }

    /** Coming back, with how long the activity was away: the page probes its
     * wire on this rather than reloading (mainview/ios.tsx). */
    override fun onResume() {
        super.onResume()
        if (!away) return
        away = false
        deliver(JSONObject().put("t", "resumed").put("away", SystemClock.elapsedRealtime() - leftAt))
    }

    override fun onDestroy() {
        dropSocket()
        web.destroy()
        super.onDestroy()
    }

    private fun dropSocket() {
        socket?.close()
        socket = null
    }

    // --- the bridge ------------------------------------------------------------

    private fun deliver(message: JSONObject) {
        page?.postMessage(message.toString())
    }

    private fun reply(id: Int, value: Any?) = deliver(JSONObject().put("t", "reply").put("id", id).put("r", value ?: JSONObject.NULL))

    private fun fail(id: Int, why: String) = deliver(JSONObject().put("t", "fail").put("id", id).put("e", why))

    /** Back on the main thread, where the reply proxy lives. */
    private fun main(block: () -> Unit) = runOnUiThread(block)

    private fun received(text: String) {
        val body = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (body.optString("t")) {
            "frame" -> {
                val bytes = runCatching { Base64.decode(body.optString("b"), Base64.DEFAULT) }.getOrNull() ?: return
                socket?.send(bytes)
            }
            "call" -> call(body.optInt("id"), body.optString("m"), body.optJSONObject("p") ?: JSONObject())
        }
    }

    private fun call(id: Int, method: String, params: JSONObject) {
        when (method) {
            "@hello" -> {
                val line = runCatching { DeviceKey.authorizedKeysLine(DeviceKey.load(), store.client) }.getOrDefault("")
                reply(id, JSONObject()
                    .put("client", store.client)
                    .put("label", ServerStore.label(this))
                    .put("destination", store.selected()?.destination.orEmpty())
                    .put("key", line))
            }
            "@open" -> open(id)
            "@close" -> {
                // By generation: a close for a socket already replaced must not
                // take the live one with it.
                if (socket?.generation == params.optInt("gen", -1)) dropSocket()
                reply(id, null)
            }
            "@log" -> {
                Log.i(TAG, "[view] ${params.optString("text")}")
                reply(id, null)
            }
            // Which accessory bar the keyboard wears (ios.md §7). There is no
            // bar here yet, so the answer is only acknowledged.
            "@focus" -> reply(id, null)

            "clipboard.read" -> reply(id, clip()?.coerceToText(this)?.toString().orEmpty())
            "clipboard.write" -> {
                clipboard().setPrimaryClip(ClipData.newPlainText("Ledge", params.optString("text")))
                reply(id, null)
            }
            "clipboard.readRich" -> {
                val item = clip()
                reply(id, JSONObject()
                    .put("text", item?.coerceToText(this)?.toString().orEmpty())
                    .put("html", item?.htmlText.orEmpty()))
            }
            // Pictures are not carried yet: "" is the answer for no image, and
            // the page pastes nothing.
            "clipboard.image", "image.encode", "image.pick" -> reply(id, "")
            "link.open" -> reply(id, JSONObject().put("ok", openLink(params.optString("url"))))
            "share.text" -> {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, params.optString("text"))
                startActivity(Intent.createChooser(send, null))
                reply(id, JSONObject().put("ok", true))
            }
            // There is no menu bar on a phone. The page answers this itself; the
            // case is here so a page that asks gets an answer, not a hang.
            "menu.set" -> reply(id, null)

            "servers.list" -> {
                val stored = store.load()
                reply(id, JSONObject()
                    .put("servers", JSONArray().apply { stored.servers.forEach { put(it.toJson()) } })
                    .put("selected", stored.selected))
            }
            "servers.save" -> {
                val rows = params.optJSONArray("servers") ?: JSONArray()
                val servers = (0 until rows.length()).mapNotNull { rows.optJSONObject(it)?.let(ServerRecord::fromJson) }
                store.save(servers, params.optString("selected"))
                reply(id, JSONObject().put("ok", true))
            }
            "servers.probe" -> {
                val destination = params.optString("destination").trim()
                val port = params.optInt("port", 0)
                thread(name = "ledge-probe", isDaemon = true) {
                    val offer = SshTransport.probe(destination, port)
                    main {
                        reply(id, JSONObject()
                            .put("hostKey", offer.hostKey).put("fingerprint", offer.fingerprint)
                            .put("keyType", offer.keyType).put("error", offer.error))
                    }
                }
            }
            else -> fail(id, "the Ledge shell has no $method yet")
        }
    }

    private fun open(id: Int) {
        if (away) return fail(id, "the app is in the background")
        dropSocket()
        val server = store.selected() ?: return fail(id, "No server is set up on this phone yet.")
        val key = runCatching { DeviceKey.load() }.getOrElse { return fail(id, "This phone's key is unavailable: ${it.message}") }
        generation += 1
        val gen = generation
        val next = SshTransport(gen, server, key) { Log.i(TAG, it) }
        socket = next
        next.open(
            ready = { result ->
                main {
                    result.fold(
                        onSuccess = { reply(id, JSONObject().put("gen", gen)) },
                        onFailure = { fail(id, it.message ?: "the dial failed") },
                    )
                }
            },
            bytes = { data ->
                val b = Base64.encodeToString(data, Base64.NO_WRAP)
                main { deliver(JSONObject().put("t", "frame").put("gen", gen).put("b", b)) }
            },
            end = { main { deliver(JSONObject().put("t", "closed").put("gen", gen)) } },
        )
    }

    private fun clipboard() = getSystemService(ClipboardManager::class.java)

    private fun clip(): ClipData.Item? = clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)

    /** http, https and mailto, the iOS rule (ios/Sources/Natives.swift), so a
     * `javascript:` link is refused here and not only in the view. */
    private fun openLink(raw: String): Boolean {
        val text = raw.trim()
        if (text.isEmpty() || text.any { it.isWhitespace() }) return false
        val uri = Uri.parse(text)
        if (uri.scheme?.lowercase() !in setOf("http", "https", "mailto")) return false
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    private companion object {
        const val TAG = "ledge"
        const val ORIGIN_HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$ORIGIN_HOST"
        const val ENTRY = "$ORIGIN/assets/android.html"
    }
}
