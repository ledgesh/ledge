package sh.ledge.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Bitmap
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
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
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
    /** Set once this window has handed itself to the server screens, so a
     * ladder still dialling cannot ask for them twice. */
    private var leaving = false

    private lateinit var bar: AccessoryBar
    /** Insert Image's sources, registered before the activity starts. */
    private val pictures = ImagePicker(this)
    /** Whether the keyboard is up, from the insets: the bar shows only then. */
    private var typing = false
    /** Whether the page has a layer open for Back to close (`@back`). */
    private var layered = false
    /** Back closes the page's top layer while it has one, and otherwise puts
     * the app behind the launcher. Not the default, which finishes this
     * activity and takes the page, its runs and its socket with it. */
    private val back = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (layered) deliver(JSONObject().put("t", "back")) else moveTaskToBack(true)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        adoptLaunchServer(intent)
        // Nothing to dial: a first launch, a pin dropped by `repair`, or the
        // last server removed. The screens before any of this are the answer
        // (ios.md §4), with a tapped link's code on top when there is one.
        if (store.selected() == null) {
            val link = pairingLink(intent)
            startActivity(ServerScreens.root(this).apply {
                if (link != null) putExtra(ServerScreens.EXTRA_CODE, link).putExtra(ServerScreens.EXTRA_TAPPED, true)
            })
            leaving = true
            finish()
            return
        }

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
            // A new page, including one the page reloaded itself: no layer
            // open and no field focused, until it says otherwise.
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                layered = false
                bar.wear("none")
                showBar()
            }

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
        // the keyboard are this window's to stay clear of. Padding by all
        // three keeps the page's own layout what it is on iOS: a full screen
        // that shrinks while the keyboard is up (ios.md §7). The padding is a
        // container's, because a WebView draws its page under its own. The bar
        // sits at the container's foot, which is the keyboard's top edge.
        bar = AccessoryBar(
            this,
            verb = { deliver(JSONObject().put("t", "verb").put("id", it)) },
            key = { deliver(JSONObject().put("t", "key").put("k", it)) },
        )
        val frame = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        frame.addView(web, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        frame.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
            val clear = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(clear.left, clear.top, clear.right, clear.bottom)
            typing = insets.isVisible(WindowInsetsCompat.Type.ime())
            showBar()
            WindowInsetsCompat.CONSUMED
        }
        setContentView(frame)
        onBackPressedDispatcher.addCallback(this, back)
        barIcons(resources.configuration)

        val server = store.selected()
        Log.i(TAG, "[shell] ledge -> ${server?.destination ?: "no server"}, client ${store.client}, as \"${ServerStore.label(this)}\"")
        // So the line to install is in the log before there is a screen to
        // show it on.
        runCatching { DeviceKey.load() }
            .onSuccess { Log.i(TAG, "[pair] ${DeviceKey.authorizedKeysLine(it, store.client)}") }
            .onFailure { Log.e(TAG, "[shell] no device key: ${it.message}") }
        web.loadUrl(ENTRY)
        openCode(intent)
    }

    private fun showBar() {
        bar.visibility = if (typing && bar.hasFace) View.VISIBLE else View.GONE
    }

    /** The bars are drawn over the theme's background, which follows the
     * system's dark setting as the page does, so their icons follow it too.
     * A switch rebuilds the activity (uiMode is not among the manifest's
     * configChanges), since the web view reads its colour scheme from the
     * theme it was created under. */
    private fun barIcons(config: Configuration) {
        val dark = config.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (adoptLaunchServer(intent)) {
            dropSocket()
            web.loadUrl(ENTRY)
        }
        openCode(intent)
    }

    /** A `ledge://pair#…` link, or null. https://ledge.sh/pair links arrive
     * the same way once the site publishes its asset links (ios.md §12). */
    private fun pairingLink(intent: Intent?): String? =
        intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString

    /**
     * A tapped pairing link, over the app: the page keeps its connection until
     * Connect succeeds and the app is rebuilt around the new selection. A link
     * that is not a code says why rather than opening an empty form.
     */
    private fun openCode(intent: Intent?) {
        val link = pairingLink(intent) ?: return
        when (val read = PairingCode.read(link)) {
            is PairingCode.Read.Code -> startActivity(
                Intent(this, ServerScreens::class.java)
                    .putExtra(ServerScreens.EXTRA_CODE, link)
                    .putExtra(ServerScreens.EXTRA_TAPPED, true),
            )
            is PairingCode.Read.Problem -> AlertDialog.Builder(this)
                .setTitle("Ledge cannot open this link")
                .setMessage(read.problem)
                .setPositiveButton("OK", null)
                .show()
        }
    }

    /**
     * Hand the window to the server screens, with the reason to show on them.
     * The web view goes with it: the next page boots around whatever gets
     * selected there, rather than being pointed somewhere else.
     */
    private fun showServers(because: String?, repair: String? = null) {
        if (leaving) return
        leaving = true
        dropSocket()
        startActivity(ServerScreens.root(this, because?.ifEmpty { null }, repair))
        finish()
    }

    /**
     * A failure retrying cannot fix: a refused key or password, or a host key
     * that changed. The pin is dropped and the address kept, since the address
     * is still the one the user meant and the key is the thing to look at
     * again, so this lands on the form rather than the list.
     */
    private fun repair(refused: ServerRecord, why: String) {
        if (leaving) return
        store.forgetPin(refused.id)
        showServers(why, repair = refused.id)
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
        if (::web.isInitialized) web.destroy()
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
                    .put("key", line)
                    .put("back", true))
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
            // Which face the keyboard's bar wears (ios.md §7).
            "@focus" -> {
                bar.wear(params.optString("over"))
                showBar()
                reply(id, null)
            }
            "@back" -> {
                layered = params.optBoolean("open")
                reply(id, null)
            }

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
            // Pictures answer base64 or "" for none (ImagePicker.kt). The two
            // reads decode off the main thread; the pick waits on a person.
            "clipboard.image" -> picture(id) { ImagePicker.clipboard(this) }
            "image.encode" -> {
                val pasted = params.optString("dataB64")
                picture(id) { ImagePicker.pasted(pasted) }
            }
            "image.pick" -> pictures.pick { reply(id, it) }
            "link.open" -> reply(id, JSONObject().put("ok", openLink(params.optString("url"))))
            "share.text" -> {
                share(this, params.optString("text"))
                reply(id, JSONObject().put("ok", true))
            }
            // The camera over the app, for the connection dialog's Add Server
            // form. Answered once it is up: a code pairs on the native screen,
            // which rebuilds the app, and a cancel returns to the form.
            "pairing.scan" -> {
                reply(id, JSONObject().put("ok", true))
                startActivity(Intent(this, ServerScreens::class.java).putExtra(ServerScreens.EXTRA_OVER, true))
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
            // The page owns every rule about the list; this stores the bytes.
            // A save that leaves nothing to dial, such as the last server
            // removed, hands the window to the server screens after the reply,
            // since that tears down the page that asked.
            "servers.save" -> {
                val rows = params.optJSONArray("servers") ?: JSONArray()
                val servers = (0 until rows.length()).mapNotNull { rows.optJSONObject(it)?.let(ServerRecord::fromJson) }
                store.save(servers, params.optString("selected"))
                reply(id, JSONObject().put("ok", true))
                if (store.selected() == null) showServers(null)
            }
            // Its own call, so a password crosses the bridge when it changes
            // and never on a rename. A string stores, null forgets, and nothing
            // reads one back.
            "servers.password" -> {
                val password = if (params.isNull("password")) null else params.optString("password")
                reply(id, JSONObject().put("ok", store.keepPassword(params.optString("id"), password)))
            }
            // The way out of a boot that failed (mainview/ios.tsx): the page
            // asking for the screens it cannot draw. Replied to first, because
            // the swap tears down the web view that asked.
            "servers.choose" -> {
                reply(id, JSONObject().put("ok", true))
                showServers(params.optString("because"))
            }
            "servers.probe" -> {
                val destination = params.optString("destination").trim()
                val port = params.optInt("port", 0)
                val answer = { key: String, print: String, type: String, error: String ->
                    reply(id, JSONObject().put("hostKey", key).put("fingerprint", print).put("keyType", type).put("error", error))
                }
                ServerRecord.problem(destination)?.let { return answer("", "", "", it) }
                thread(name = "ledge-probe", isDaemon = true) {
                    val offer = runCatching { SshTransport.probe(destination, port) }
                    main {
                        offer.fold(
                            onSuccess = { answer(it.line, it.fingerprint, it.keyType, "") },
                            onFailure = { answer("", "", "", it.message.orEmpty()) },
                        )
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
        val next = SshTransport(
            gen, server, key,
            // The pinned case, always: nothing in the running app can be asked
            // to trust a new key.
            hostKey = PinnedHostKey(server.hostKey),
            // Read here and not held between connections. A password record
            // with none stored offers the empty string, which the server
            // refuses by name, and that refusal leads to pairing.
            password = if (server.usesPassword) store.password(server.id).orEmpty() else null,
            log = { Log.i(TAG, it) },
        )
        socket = next
        next.open(
            ready = { result ->
                main {
                    result.fold(
                        onSuccess = { reply(id, JSONObject().put("gen", gen)) },
                        onFailure = {
                            val why = it.message ?: "the dial failed"
                            fail(id, why)
                            if ((it as? SshFailure)?.needsPairing == true) repair(server, why)
                        },
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

    /** The clipboard's first item when it is text. A copied picture is a
     * content URI, which `coerceToText` would spell out and a paste would then
     * insert as a line of text rather than as the image. */
    private fun clip(): ClipData.Item? =
        clipboard().primaryClip?.takeIf { it.itemCount > 0 && !it.description.hasMimeType("image/*") }?.getItemAt(0)

    private fun picture(id: Int, read: () -> String) {
        thread(name = "ledge-picture", isDaemon = true) {
            val base64 = runCatching(read).getOrDefault("")
            main { reply(id, base64) }
        }
    }

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
