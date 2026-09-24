package sh.ledge.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The shell's own screens, for the state where there is no page (ios.md §4):
 * a phone with no server, one whose server stopped answering, or one whose
 * pin was dropped. The counterpart of iOS's AppDelegate `showServers` and the
 * four view controllers it stacks.
 *
 * | Screen | What it is |
 * | --- | --- |
 * | Welcome | The root on a phone with no servers |
 * | Servers | The root otherwise: the stored servers, and a row that adds one |
 * | Pairing | The form, pushed off either root, or alone over the app for a code |
 * | Setup | The commands that make a machine a server |
 *
 * They select and pair, and nothing else: renaming, editing and removing are
 * rules, and the connection dialog holds them (remote.md §8). Every way off
 * these screens into the app starts WebHost afresh, so the page boots around
 * whatever was just selected.
 */
class ServerScreens : ComponentActivity() {
    private lateinit var store: ServerStore

    private sealed interface Screen {
        data object Welcome : Screen
        data object Setup : Screen
        data object Servers : Screen
        data object Scanner : Screen
        data class Pairing(val start: PairingStart, val because: String?, val scannable: Boolean) : Screen
    }

    private val stack = mutableStateListOf<Screen>()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        runCatching { DeviceKey.load() }.onSuccess { DeviceKey.log(it, store.client) }
        stack.addAll(initialStack(intent))
        setContent {
            LedgeTheme {
                val top = stack.last()
                BackHandler(enabled = stack.size > 1) { stack.removeAt(stack.lastIndex) }
                Frame(top)
            }
        }
    }

    /**
     * What the screens open on, from the intent WebHost sent. Over the app
     * there is no list beneath: Back returns to the page, which kept its
     * connection. Otherwise the list or the welcome screen is the root, with
     * the form on top when there is an address to show (iOS's `showServers`).
     */
    private fun initialStack(intent: Intent): List<Screen> {
        val because = intent.getStringExtra(EXTRA_BECAUSE)
        intent.getStringExtra(EXTRA_CODE)?.let { link ->
            val read = PairingCode.read(link)
            if (read is PairingCode.Read.Code) {
                return listOf(Screen.Pairing(PairingStart.FromCode(read.code, intent.getBooleanExtra(EXTRA_TAPPED, false)), null, false))
            }
        }
        if (intent.getBooleanExtra(EXTRA_OVER, false)) return listOf(Screen.Scanner)
        val stored = store.load()
        val refused = intent.getStringExtra(EXTRA_REPAIR)?.let { id -> stored.servers.firstOrNull { it.id == id } }
        val selected = refused ?: stored.servers.firstOrNull { it.id == stored.selected }
        val form = Screen.Pairing(PairingStart.Typed(selected?.destination.orEmpty(), selected?.port ?: 0), because, true)
        return if (stored.servers.isEmpty()) {
            listOfNotNull(Screen.Welcome, form.takeIf { refused != null || because != null })
        } else {
            listOfNotNull(Screen.Servers, form.takeIf { refused != null })
        }
    }

    private fun push(screen: Screen) {
        stack.add(screen)
    }

    private fun scan() = push(Screen.Scanner)

    /** Into the app, rebuilt around the selection. */
    private fun enterApp() {
        startActivity(Intent(this, WebHost::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun Frame(top: Screen) {
        val title = when (top) {
            Screen.Welcome -> ""
            Screen.Setup -> "Set up a server"
            Screen.Servers -> "Servers"
            Screen.Scanner -> "Scan a pairing code"
            is Screen.Pairing -> "Pair with a server"
        }
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(title) },
                    navigationIcon = {
                        if (stack.size > 1 || intent.getBooleanExtra(EXTRA_OVER, false) || intent.hasExtra(EXTRA_CODE)) {
                            IconButton(onClick = { if (stack.size > 1) stack.removeAt(stack.lastIndex) else finish() }) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                            }
                        }
                    },
                )
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
                when (top) {
                    Screen.Welcome -> Welcome(
                        onScan = ::scan,
                        onSetup = { push(Screen.Setup) },
                        onExisting = ::existing,
                    )
                    Screen.Setup -> Setup(onScan = ::scan, onExisting = ::existing)
                    Screen.Servers -> {
                        val stored = remember { store.load() }
                        // Why the list came up, in the page's own words, which
                        // name the machine and what went wrong with it.
                        Servers(stored.servers, stored.selected, intent.getStringExtra(EXTRA_BECAUSE), onChosen = { id ->
                            // Storing the selection is all this takes, so choosing
                            // the one already selected is how this screen retries.
                            store.select(id)
                            enterApp()
                        }, onAdd = { suggest, port ->
                            push(Screen.Pairing(PairingStart.Typed(suggest, port), null, true))
                        })
                    }
                    Screen.Scanner -> CodeScanner { code ->
                        // The code's form replaces the camera, so Back from it
                        // returns to the screen the scan started from.
                        stack[stack.lastIndex] = Screen.Pairing(PairingStart.FromCode(code, tapped = false), null, false)
                    }
                    is Screen.Pairing -> PairingForm(
                        store = store,
                        start = top.start,
                        because = top.because,
                        onScan = if (top.scannable) ::scan else null,
                        onPaired = { enterApp() },
                    )
                }
            }
        }
    }

    /** The typed form without its scan button: the person chose it instead of
     * one. It replaces the setup screen, so Back returns to the welcome screen. */
    private fun existing() {
        while (stack.size > 1) stack.removeAt(stack.lastIndex)
        push(Screen.Pairing(PairingStart.Typed("", 0), null, false))
    }

    companion object {
        const val EXTRA_BECAUSE = "because"
        /** A record whose pin `repair` just dropped, to pre-fill the form with. */
        const val EXTRA_REPAIR = "repair"
        /** A pairing link, and whether it was tapped rather than scanned. */
        const val EXTRA_CODE = "code"
        const val EXTRA_TAPPED = "tapped"
        /** Over the app, from the page's Add Server form: the camera alone. */
        const val EXTRA_OVER = "over"

        /** The screens as the window's only content, with a reason to show. */
        fun root(context: Context, because: String? = null, repair: String? = null): Intent =
            Intent(context, ServerScreens::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                .apply {
                    because?.let { putExtra(EXTRA_BECAUSE, it) }
                    repair?.let { putExtra(EXTRA_REPAIR, it) }
                }
    }
}

/** What the pairing form starts from: an address to type, maybe pre-filled,
 * or a code, scanned or tapped. */
sealed interface PairingStart {
    data class Typed(val suggest: String, val port: Int) : PairingStart
    data class FromCode(val code: PairingCode, val tapped: Boolean) : PairingStart
}

// --- the theme ------------------------------------------------------------------

@Composable
fun LedgeTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> darkColorScheme()
        else -> lightColorScheme()
    }
    MaterialTheme(colorScheme = colors) { Surface(Modifier.fillMaxSize(), content = content) }
}

private val Mono = FontFamily.Monospace

/** A screen's scrolling column: a phone's width, or a column in the middle of
 * a tablet. */
@Composable
private fun Page(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp)
            .widthIn(max = 560.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}

@Composable
private fun Footnote(text: String) =
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun Reason(text: String) = Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)

@Composable
private fun CommandBox(text: String) {
    SelectionContainer {
        Text(
            text,
            fontFamily = Mono,
            fontSize = 12.sp,
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                .padding(10.dp),
        )
    }
}

private fun copy(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Ledge", text))
}

/** The one string a phone has to get onto another machine, through the
 * system's share sheet, since a copy can only be pasted on this phone. */
fun share(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

// --- welcome --------------------------------------------------------------------

/** The manual's page for the phone, for someone who installed the app
 * knowing nothing else. */
private const val GUIDE = "https://ledge.sh/docs/ledge-on-your-phone"

@Composable
private fun Welcome(onScan: () -> Unit, onSetup: () -> Unit, onExisting: () -> Unit) {
    val context = LocalContext.current
    Page {
        LedgeMark(64)
        Spacer(Modifier.size(6.dp))
        Text("Connect to your Ledge server", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Text(
            "Ledge is a Markdown notebook that runs the code in your notes. On an Android phone it opens the notes on your own server, a Mac or a Linux machine, over ssh.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(GUIDE))) }, contentPadding = PaddingValues(0.dp)) {
            Text("New to Ledge? Read the guide")
        }
        Spacer(Modifier.size(12.dp))
        Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text("Scan a pairing code") }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(
                " ledge pair ",
                fontFamily = Mono,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp)),
            )
            Footnote(" shows one in a terminal on the server.")
        }
        Spacer(Modifier.size(16.dp))
        ListItem(
            headlineContent = { Text("I don't have a server yet") },
            supportingContent = { Text("Set one up on a Mac or Linux machine") },
            trailingContent = { Text("›", style = MaterialTheme.typography.titleLarge) },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onSetup),
        )
        TextButton(onClick = onExisting) { Text("Add an existing server") }
    }
}

/** The Ledge mark from `assets/logo.svg`, lime on the app icon's dark tile. */
@Composable
private fun LedgeMark(side: Int) {
    Canvas(Modifier.size(side.dp).background(Color(0xFF1A1A1A), RoundedCornerShape((side * 0.225f).dp))) {
        // The logo's box is 91.80 by 84.95, drawn at two thirds of the tile's
        // width, centred (assets/Ledge.icon).
        val scale = size.width * 0.664f / 91.80f
        val dx = (size.width - 91.80f * scale) / 2
        val dy = (size.height - 84.95f * scale) / 2
        fun at(x: Float, y: Float) = androidx.compose.ui.geometry.Offset(dx + x * scale, dy + y * scale)
        val path = Path().apply {
            at(0f, 70f).let { moveTo(it.x, it.y) }
            at(15.5f, 70f).let { lineTo(it.x, it.y) }
            at(60.96f, 0f).let { lineTo(it.x, it.y) }
            at(45.46f, 0f).let { lineTo(it.x, it.y) }
            close()
            val a = at(33.8f, 73.9f)
            val b = at(33.8f + 58f, 73.9f + 11.05f)
            addRect(androidx.compose.ui.geometry.Rect(a.x, a.y, b.x, b.y))
        }
        drawPath(path, Color(0xFFE6F256))
    }
}

// --- setup ----------------------------------------------------------------------

/** ledge.sh/server.sh, then the pair verb by its full path, because the PATH
 * line the installer adds reaches only new terminals (ios.md §4). */
private val SETUP_COMMANDS = listOf(
    "curl -fsSL https://ledge.sh/server.sh | sh",
    "~/.ledge/.server/bin/ledge pair",
)

@Composable
private fun Setup(onScan: () -> Unit, onExisting: () -> Unit) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    val commands = SETUP_COMMANDS.joinToString("\n")
    Page {
        Text("A server is a Mac or Linux machine that stays on and accepts ssh, such as a VPS or a computer at home.")
        Text("In a terminal on that machine, signed in as the account Ledge should use rather than root, run these two commands. Neither needs sudo.")
        CommandBox(commands)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = {
                copy(context, commands)
                copied = true
            }) { Text("Copy commands") }
            TextButton(onClick = { share(context, commands) }) { Text("Share commands") }
        }
        if (copied) Footnote("Copied. Paste them into a terminal on the server.")
        Text("The second command shows a pairing code for that account.")
        Text("On a Mac, turn on Remote Login first, in System Settings under General, then Sharing. If the Ledge app runs on that Mac, choose Install Shell Command (ledge) in the app instead of the first command.")
        Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text("Scan the pairing code") }
        Footnote("The server runs on macOS, or on Linux with glibc 2.29 or newer (Debian 11, Ubuntu 20.04, RHEL 9, or later), on arm64 or x64. The machine needs sshd running, and this phone has to be able to reach its address.")
        TextButton(onClick = onExisting) { Text("Add an existing server") }
    }
}

// --- the server list ------------------------------------------------------------

@Composable
private fun Servers(
    servers: List<ServerRecord>,
    selected: String,
    reason: String?,
    onChosen: (String) -> Unit,
    onAdd: (String, Int) -> Unit,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        reason?.let { Box(Modifier.padding(horizontal = 20.dp, vertical = 12.dp)) { Reason(it) } }
        if (servers.isNotEmpty()) {
            Text("Connect to", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 20.dp, top = 8.dp))
        }
        for (server in servers) {
            // The address under the name, because two servers can share a name
            // and the address is what gets dialled. A record whose pin was
            // dropped cannot be dialled, so its row leads to the form instead.
            val where = if (server.port == 0) server.destination else "${server.destination}:${server.port}"
            ListItem(
                headlineContent = { Text(server.name.ifEmpty { server.destination }) },
                supportingContent = { Text(if (server.hostKey.isEmpty()) "$where (needs pairing again)" else where) },
                trailingContent = { if (server.id == selected) Text("✓", style = MaterialTheme.typography.titleMedium) },
                modifier = Modifier.clickable {
                    if (server.hostKey.isEmpty()) onAdd(server.destination, server.port) else onChosen(server.id)
                },
            )
        }
        HorizontalDivider()
        ListItem(
            headlineContent = { Text("Add a server", color = MaterialTheme.colorScheme.primary) },
            modifier = Modifier.clickable { onAdd("", 0) },
        )
    }
}

// --- pairing --------------------------------------------------------------------

/**
 * The form that adds a server (ios.md §4): the counterpart of iOS's
 * PairingViewController, whose comment has the reasoning.
 *
 * Typed, the host key is confirmed by a person during the handshake it
 * belongs to, and there is no continue-anyway button. From a code, the key is
 * judged against the code (`PairingCode.match`) and nobody is asked. Either
 * way the record is stored only once `ledge serve` has answered.
 */
@Composable
private fun PairingForm(
    store: ServerStore,
    start: PairingStart,
    because: String?,
    onScan: (() -> Unit)?,
    onPaired: () -> Unit,
) {
    val context = LocalContext.current
    val code = (start as? PairingStart.FromCode)?.code
    val held = remember { runCatching { DeviceKey.load() } }
    val command = remember { held.getOrNull()?.let { DeviceKey.authorizeCommand(DeviceKey.authorizedKeysLine(it, store.client)) }.orEmpty() }

    var destination by remember { mutableStateOf((start as? PairingStart.Typed)?.suggest.orEmpty()) }
    var port by remember { mutableStateOf((start as? PairingStart.Typed)?.port?.takeIf { it > 0 }?.toString().orEmpty()) }
    var byPassword by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var reveal by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf(held.exceptionOrNull()?.let { "This phone's key is unavailable: ${it.message}" }.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<Pair<HostKeyOffer, (Boolean) -> Unit>?>(null) }
    // The key already pinned at the code's address, when it refuses the code.
    var conflict by remember {
        mutableStateOf((code?.match(store.known()) as? PairingCode.Match.Conflict)?.pinned)
    }
    val dial = remember { PairingDial(store) }
    DisposableEffect(Unit) { onDispose { dial.cancel() } }

    fun connect() {
        if (busy || held.isFailure) return
        val secret = if (byPassword) password else null
        if (secret != null && secret.isEmpty()) {
            status = "Enter the password for that account."
            return
        }
        val plan = if (code != null) {
            dial.forCode(code) ?: run {
                conflict = (code.match(store.known()) as? PairingCode.Match.Conflict)?.pinned
                return
            }
        } else {
            val typed = destination.trim()
            ServerRecord.problem(typed)?.let {
                status = it
                return
            }
            val p = port.trim().let { if (it.isEmpty()) 0 else it.toIntOrNull()?.takeIf { n -> n in 1..65535 } ?: -1 }
            if (p < 0) {
                status = "A port is a whole number from 1 to 65535."
                return
            }
            dial.forTyped(typed, p) { offer, decide -> asking = offer to decide }
        }
        busy = true
        status = "Connecting to ${plan.destination}…"
        dial.run(plan, held.getOrThrow(), secret) { outcome ->
            busy = false
            when (outcome) {
                is PairingDial.Outcome.Failed -> status = outcome.why
                PairingDial.Outcome.Refused -> {
                    conflict = code?.let { (it.match(store.known()) as? PairingCode.Match.Conflict)?.pinned }
                    if (conflict == null) {
                        status = if (secret != null) "This phone's Keystore would not store that password."
                        else "The server list changed while Ledge was connecting. Open the code again."
                    }
                }
                is PairingDial.Outcome.Paired -> onPaired()
            }
        }
    }

    Page {
        because?.let { Reason(it) }
        conflict?.let {
            Reason(
                "Ledge already has a different host key pinned for ${code?.host}, and this code does not name it, so Ledge will not use the code.\n" +
                    "If that server's host key really changed, connect to it from the server list, and Ledge shows you the new key to check.",
            )
        }
        when (start) {
            is PairingStart.Typed -> {
                if (onScan != null) {
                    Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text("Scan a pairing code") }
                    Footnote("ledge pair shows a code on the server.")
                }
                Text("1. Which machine, and which account on it.")
                OutlinedTextField(
                    destination, { destination = it },
                    label = { Text("user@host") },
                    singleLine = true,
                    enabled = !busy,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = Mono),
                    // A destination is not prose: capitals and corrections
                    // would turn ledge@box into Ledge@box.
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Email,
                        imeAction = ImeAction.Go,
                    ),
                    keyboardActions = KeyboardActions(onGo = { connect() }),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    port, { port = it },
                    label = { Text("Port (leave blank for 22)") },
                    singleLine = true,
                    enabled = !busy,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = Mono),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { connect() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            is PairingStart.FromCode -> {
                // A code the camera read came from a screen in front of the
                // person holding the phone; a link could have been sent by
                // anyone (remote.md §4b, the third rule).
                if (start.tapped) {
                    Text(
                        "You opened this code from a link, and anyone can send one. Connect only if the link came from your own server.",
                        color = Color(0xFFE08A00),
                    )
                }
                CodeSummary(start.code, conflict)
            }
        }

        Text("Sign in with")
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("A key", "A password").forEachIndexed { i, label ->
                SegmentedButton(
                    selected = byPassword == (i == 1),
                    onClick = {
                        byPassword = i == 1
                        status = ""
                    },
                    enabled = !busy,
                    shape = SegmentedButtonDefaults.itemShape(i, 2),
                ) { Text(label) }
            }
        }
        if (!byPassword) {
            // What the command does first, then what the restriction is good
            // for, rather than a claim that the key is harmless (remote.md §4a).
            Text(
                (if (code == null) "2. " else "") +
                    "Run this command on the server, signed in as the account Ledge uses. It adds this phone's public key to ~/.ssh/authorized_keys, which is how that server knows to let this phone in. Share command sends it to another device. The restrict prefix keeps the key from forwarding ports or copying files.",
            )
            CommandBox(command)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    copy(context, command)
                    status = "Copied. Run it on the server, then connect."
                }) { Text("Copy command") }
                TextButton(onClick = { share(context, command) }) { Text("Share command") }
            }
        } else {
            OutlinedTextField(
                password, { password = it },
                label = { Text("Password for that account") },
                singleLine = true,
                enabled = !busy,
                visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { connect() }),
                trailingIcon = {
                    TextButton(onClick = { reveal = !reveal }, enabled = !busy) { Text(if (reveal) "Hide" else "Show") }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            Footnote("Kept on this phone, sealed with a key in its Android Keystore, where only Ledge can read it.")
        }

        Button(onClick = ::connect, enabled = !busy && held.isSuccess && conflict == null, modifier = Modifier.fillMaxWidth()) {
            Text("Connect")
        }
        if (busy) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        if (status.isNotEmpty()) Footnote(status)
    }

    asking?.let { (offer, decide) ->
        val answer = { yes: Boolean ->
            asking = null
            decide(yes)
        }
        val file = if ("ed25519" in offer.keyType) "ed25519" else "ecdsa"
        AlertDialog(
            onDismissRequest = { answer(false) },
            title = { Text("Is this the server?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(offer.fingerprint, fontFamily = Mono)
                    Text("Run this on the server to compare:")
                    Text("ssh-keygen -lf /etc/ssh/ssh_host_${file}_key.pub", fontFamily = Mono, fontSize = 12.sp)
                }
            },
            confirmButton = { TextButton(onClick = { answer(true) }) { Text("Trust") } },
            dismissButton = { TextButton(onClick = { answer(false) }) { Text("Cancel") } },
        )
    }
}

/** The code's fields, one caption and value per row, so a long host name or a
 * fingerprint wraps at any text size. */
@Composable
private fun CodeSummary(code: PairingCode, pinned: String?) {
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        @Composable
        fun field(caption: String, values: List<String>, mono: Boolean = false, color: Color = Color.Unspecified) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Footnote(caption)
                values.forEach { Text(it, fontFamily = if (mono) Mono else null, fontSize = if (mono) 13.sp else 16.sp, color = color) }
            }
        }
        field("Account", listOf(code.user))
        field("Host", listOf(code.host))
        field("Port", listOf(if (code.port == 0) "22" else code.port.toString()))
        field(if (code.fingerprints.size == 1) "Host key" else "Host keys", code.fingerprints, mono = true)
        pinned?.let { field("Pinned in Ledge", listOf(it), mono = true, color = MaterialTheme.colorScheme.error) }
        Footnote("Ledge signs in only if the server offers one of these host keys.")
    }
}

/**
 * One pairing dial: where to, how the offered host key is judged, and how the
 * result is stored once `ledge serve` has answered. Callbacks arrive on the
 * main thread.
 */
private class PairingDial(private val store: ServerStore) {
    class Plan(
        val destination: String,
        val port: Int,
        val judge: HostKeyJudge,
        /** The line of the key the dial accepted, read after it succeeds. */
        val accepted: () -> String?,
        /** Stores the pin and the door, or answers null when the list refuses. */
        val store: (hostKey: String, auth: String, password: String?) -> ServerRecord?,
        val timeoutMs: Long,
    )

    sealed interface Outcome {
        data class Failed(val why: String) : Outcome
        data object Refused : Outcome
        data class Paired(val record: ServerRecord) : Outcome
    }

    private val main = Handler(Looper.getMainLooper())
    private var transport: SshTransport? = null
    private var confirming: ConfirmingHostKey? = null
    private var pending: ((Boolean) -> Unit)? = null

    fun forTyped(destination: String, port: Int, ask: (HostKeyOffer, (Boolean) -> Unit) -> Unit): Plan {
        val judge = ConfirmingHostKey { offer, decide ->
            main.post {
                pending = decide
                ask(offer) { yes ->
                    pending = null
                    decide(yes)
                }
            }
        }
        confirming = judge
        // By address, so pairing again after a host key changed re-pins the
        // record already there rather than leaving a duplicate.
        return Plan(destination, port, judge, { judge.accepted?.line }, { key, auth, secret ->
            store.pair(destination, port, key, auth, secret)
        }, ASKING_TIMEOUT_MS)
    }

    /** The code's dial, or null when the stored list refuses the code. */
    fun forCode(code: PairingCode): Plan? {
        val (judge, accepted) = when (val match = code.match(store.known())) {
            is PairingCode.Match.Conflict -> return null
            // The pin decides, as on every other dial to this record.
            is PairingCode.Match.Pinned -> {
                val pin = store.load().servers.firstOrNull { it.id == match.id }?.hostKey ?: return null
                PinnedHostKey(pin) to { pin }
            }
            PairingCode.Match.New, is PairingCode.Match.Unpinned -> {
                val checking = CodeHostKey(code.fingerprints)
                checking to { checking.accepted?.line }
            }
        }
        return Plan(code.destination, code.port, judge, accepted, { key, auth, secret ->
            store.pair(code, key, auth, secret)
        }, SshTransport.DIAL_TIMEOUT_MS)
    }

    fun run(plan: Plan, key: DeviceKey.Held, password: String?, done: (Outcome) -> Unit) {
        val candidate = ServerRecord("", "", plan.destination, plan.port, "", "key")
        val next = SshTransport(0, candidate, key, plan.judge, password, { Log.i("ledge", "[pair] $it") }, plan.timeoutMs)
        transport = next
        var settled = false
        // Main thread only, and the first call wins. Closed either way: this
        // was a question, and the connection the app runs on is the page's.
        fun settle(result: Result<Unit>) {
            if (settled) return
            settled = true
            next.close()
            transport = null
            result.fold(
                onFailure = { done(Outcome.Failed(it.message ?: "The connection failed.")) },
                onSuccess = {
                    val accepted = plan.accepted() ?: return done(Outcome.Failed("That server did not offer a host key."))
                    val record = plan.store(accepted, if (password == null) "key" else "password", password)
                    done(if (record == null) Outcome.Refused else Outcome.Paired(record))
                },
            )
        }
        next.open(
            ready = { result ->
                main.post {
                    // A started command is only a shell, which a machine with no
                    // server starts too. The server's hello or the command
                    // ending settles it, and ANSWER_GRACE_MS covers neither.
                    if (result.isFailure) settle(result) else main.postDelayed({ settle(result) }, ANSWER_GRACE_MS)
                }
            },
            bytes = { main.post { settle(Result.success(Unit)) } },
            end = {
                main.post {
                    settle(Result.failure(SshFailure(next.whyUnanswered() ?: "The connection was closed while it was being made.", false)))
                }
            },
        )
    }

    /** The screen went: answer any open question no, so sshj's thread is not
     * left waiting on a dialog that no longer exists. */
    fun cancel() {
        pending?.invoke(false)
        pending = null
        transport?.close()
        transport = null
    }

    private companion object {
        /** How long a started command that neither answers nor ends is
         * waited on before pairing goes ahead anyway. */
        const val ANSWER_GRACE_MS = 5_000L
        /** A typed dial's handshake waits on a person reading a fingerprint. */
        const val ASKING_TIMEOUT_MS = 180_000L
    }
}
