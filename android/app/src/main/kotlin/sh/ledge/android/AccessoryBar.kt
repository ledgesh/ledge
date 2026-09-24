package sh.ledge.android

import android.content.Context
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import android.widget.LinearLayout

/**
 * The strip above the keyboard, the counterpart of ios/Sources/AccessoryBar.swift
 * (ios.md §7). The page says which face to wear (`@focus`): the note's verbs,
 * the keys a running block needs, or no bar at all.
 *
 * No Hide Keyboard button, which iOS needs on two faces: Android's Back and
 * its navigation bar already put the keyboard away. So the `none` face is no
 * bar, rather than a bar with only that button on it.
 *
 * Both faces carry names, not behavior: a verb tap is a command id for the
 * page's registry and a key tap is a key name for the page's terminal.
 */
class AccessoryBar(context: Context, private val verb: (String) -> Unit, private val key: (String) -> Unit) :
    LinearLayout(context) {

    /** One button: an icon or a monospaced title, and what TalkBack reads. */
    private class Item(val name: String, val icon: Int?, val title: String?, val label: String)

    private var face = ""

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        val inset = dp(4)
        setPadding(inset, 0, inset, 0)
        visibility = GONE
    }

    /** Wear `over`'s face, or none. The same face again changes nothing, so a
     * row is not rebuilt under a thumb on its way down. */
    fun wear(over: String) {
        if (over == face) return
        face = over
        removeAllViews()
        when (over) {
            "note" -> VERBS.forEach { add(it) { verb(it.name) } }
            "run" -> {
                KEYS.forEach { add(it) { key(it.name) } }
                // ⌘Escape, which this keyboard cannot press: the page routes it
                // to the panel that has the keyboard, not to the program.
                add(LEAVE) { key(LEAVE.name) }
            }
        }
    }

    /** Whether there is anything to show: a face with buttons. */
    val hasFace: Boolean get() = childCount > 0

    private fun add(item: Item, tapped: () -> Unit) {
        val view: View = if (item.icon != null) {
            ImageButton(context).apply { setImageResource(item.icon) }
        } else {
            Button(context).apply {
                text = item.title
                // Terminal notation: the caret is a key name here.
                typeface = Typeface.MONOSPACE
                isAllCaps = false
                minWidth = 0
                minimumWidth = 0
            }
        }
        view.apply {
            contentDescription = item.label
            tooltipText = item.label
            // A focusable button would take focus from the web view, and the
            // keyboard would close under the tap that was meant for it.
            isFocusable = false
            isFocusableInTouchMode = false
            background = context.obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackgroundBorderless))
                .let { attrs -> attrs.getDrawable(0).also { attrs.recycle() } }
            setOnClickListener { tapped() }
        }
        addView(view, LayoutParams(0, dp(HEIGHT_DP), 1f))
    }

    private fun dp(value: Int) =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    companion object {
        /** The touch target Android's guidelines use. */
        const val HEIGHT_DP = 48

        /** The note's face in iOS's order. Insert Image joins it when this
         * client carries pictures. */
        private val VERBS = listOf(
            Item("format.outdent", R.drawable.bar_format_indent_decrease, null, "Outdent"),
            Item("format.indent", R.drawable.bar_format_indent_increase, null, "Indent"),
            Item("format.bold", R.drawable.bar_format_bold, null, "Bold"),
            Item("format.italic", R.drawable.bar_format_italic, null, "Italic"),
            Item("format.link", R.drawable.bar_link, null, "Insert Link"),
            Item("format.wikiLink", R.drawable.bar_data_array, null, "Link to Note"),
            Item("format.codeBlock", R.drawable.bar_code, null, "Code Block"),
        )

        /** The run's face. The names are the page's `RUN_KEYS`. */
        private val KEYS = listOf(
            Item("ctrlC", null, "^C", "Control C"),
            Item("ctrlD", null, "^D", "Control D"),
            Item("escape", null, "esc", "Escape"),
            Item("up", R.drawable.bar_arrow_upward, null, "Up Arrow"),
            Item("down", R.drawable.bar_arrow_downward, null, "Down Arrow"),
            Item("left", R.drawable.bar_arrow_back, null, "Left Arrow"),
            Item("right", R.drawable.bar_arrow_forward, null, "Right Arrow"),
        )

        private val LEAVE = Item("leave", R.drawable.bar_u_turn_left, null, "Back to Note")
    }
}
