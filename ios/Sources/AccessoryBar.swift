import ObjectiveC
import UIKit
import WebKit

/// The strip above the keyboard: three faces, one for the note, one for a
/// running block, and one for everything else (ios.md §7).
///
/// ⌘B, ⌘I, ⌘K, Tab and ``` are chords or punctuation, and a phone has neither:
/// the iPhone software keyboard does not even have a Tab key, and the backtick
/// is three trips through the numeric page away. This is where they go.
///
/// **The second face is a different keyboard, not more verbs.** While a block
/// is running, the keys the program wants — Ctrl-C, Ctrl-D, Escape, the arrows
/// — do not exist on a software keyboard at all, so a phone could answer a
/// `[y/N]` by typing and could not interrupt, page or navigate anything. The
/// page says which face to wear (`@focus`), because only the page knows that
/// the panel a run draws lives inside the editor it is running under.
///
/// **The third face is one button, and it is why there is always a bar.** A
/// keyboard the user cannot put away is a trap, and this page has nowhere to
/// tap that would dismiss one: it is full height, and its chrome does not blur
/// a field. So the answer to "what goes over a search box" is not "nothing" —
/// which is what it was, and what left a phone stuck behind its own keyboard —
/// but the one control that is never wrong to offer.
///
/// **Both carry names, not behavior.** A verb tap posts `{t: "verb", id: ...}`
/// and the page's command registry decides what that means, exactly as the
/// Mac's menu bar does (mainview/lib/menu.ts); a key tap posts
/// `{t: "key", k: ...}` and the page's terminal decides what bytes that is
/// (mainview/editor/inlineTerm.ts). So a renamed command leaves a button that
/// does nothing and logs why rather than one that quietly does something else,
/// and Swift holds no opinion about what "bold" is or what Ctrl-C sends.
///
/// **HTML was the alternative and §7 rules it out.** A bar drawn in the page
/// has to track the visual viewport for the life of the app: every keyboard
/// animation, every rotation, every scroll of a focused field. `inputAccessoryView`
/// is attached to the keyboard by the system and needs none of that. It is also
/// the only place the run's keys can live and still be reachable: the panel's
/// own header scrolls with the note, and a run pinned to 24 rows puts it off
/// the top of the screen.
enum AccessoryBar {
    /// The note's face, left to right. Outdent before indent because that is
    /// the order they sit in on every toolbar that has both, and the pair
    /// before the formatting trio because they act on the line rather than on
    /// the selection.
    private static let verbs: [(id: String, symbol: String, label: String)] = [
        ("format.outdent", "decrease.indent", "Outdent"),
        ("format.indent", "increase.indent", "Indent"),
        ("format.bold", "bold", "Bold"),
        ("format.italic", "italic", "Italic"),
        ("format.link", "link", "Insert Link"),
        // The `[[` picker. Typed on a desktop, and typeable here too — the
        // point is that it takes two taps on a bracket key that lives behind
        // the software keyboard's second page.
        ("format.wikiLink", "text.append", "Link to Note"),
        // ``` and its closer, which is the block this whole app is for and the
        // most expensive thing to type on this keyboard: the backtick is behind
        // the numeric page and a long press, three times over.
        ("format.codeBlock", "chevron.left.forwardslash.chevron.right", "Code Block"),
        // The photo library. Last because it is the one that leaves: it puts a
        // system picker over the whole app, where the six before it are edits
        // that happen under the thumb (ios.md §11).
        ("image.insert", "photo.on.rectangle", "Insert Image"),
    ]

    /// One key on the run's face. `symbol` is an SF Symbol where one says the
    /// key (`escape` and the arrows are drawn glyphs on real keyboards too);
    /// `title` is for the two that have no glyph anywhere, and where `^C` is
    /// what the key is CALLED.
    private struct Key {
        let name: String
        let symbol: String?
        let title: String?
        let label: String
    }

    /// The run's face: the four things a software keyboard cannot say
    /// (ios.md §14), in the order a hand reaches for them. The names are the
    /// page's `RUN_KEYS`, and nothing here knows what any of them sends.
    private static let keys: [Key] = [
        Key(name: "ctrlC", symbol: nil, title: "^C", label: "Control C"),
        Key(name: "ctrlD", symbol: nil, title: "^D", label: "Control D"),
        Key(name: "escape", symbol: "escape", title: nil, label: "Escape"),
        Key(name: "up", symbol: "arrow.up", title: nil, label: "Up Arrow"),
        Key(name: "down", symbol: "arrow.down", title: nil, label: "Down Arrow"),
        Key(name: "left", symbol: "arrow.left", title: nil, label: "Left Arrow"),
        Key(name: "right", symbol: "arrow.right", title: nil, label: "Right Arrow"),
    ]

    /// The face over a note. `tapped` is called with the command id; `dismiss`
    /// is the one button that is not a command.
    static func markdown(tapped: @escaping (String) -> Void, dismiss: @escaping () -> Void) -> UIView {
        let row = verbs.map { id, symbol, label in
            button(symbol: symbol, title: nil, label: label, id: id) { tapped(id) }
        }
        return bar(row: row, trailing: hideKeyboard(dismiss))
    }

    /// Not a command, and apart from the verbs. Nothing else on this screen
    /// puts the keyboard away: the editor fills the window, so there is no
    /// blank page to tap, and tapping the chrome does not blur a
    /// contenteditable. Without this the keyboard takes a third of the phone
    /// for the rest of the session, which is why every iOS accessory bar that
    /// ships has one — and why two of the three faces carry it.
    private static func hideKeyboard(_ dismiss: @escaping () -> Void) -> UIButton {
        button(
            symbol: "keyboard.chevron.compact.down",
            title: nil,
            label: "Hide Keyboard",
            id: "keyboard.hide",
            action: dismiss
        )
    }

    /// The face over everything else: a search box, a rename, a passphrase —
    /// any field where the note's verbs would act on the note behind it.
    ///
    /// One button, and it is the one that is not a verb. The alternative was no
    /// bar at all, which is what this used to be, and it left the keyboard with
    /// no way out: nothing on this screen dismisses it, since the page is
    /// full-height and tapping chrome does not blur a field. A row of Markdown
    /// verbs over a passphrase is wrong; Hide Keyboard over one never is.
    static func bare(dismiss: @escaping () -> Void) -> UIView {
        bar(row: [], trailing: hideKeyboard(dismiss))
    }

    /// The face over a running block. Every button is a key, the last one
    /// included: `leave` is the ⌘Escape this client cannot press, and the page
    /// routes it to the panel that has the keyboard rather than to a program.
    static func run(pressed: @escaping (String) -> Void) -> UIView {
        let row = keys.map { key in
            button(symbol: key.symbol, title: key.title, label: key.label, id: key.name) { pressed(key.name) }
        }
        let back = button(
            symbol: "arrow.uturn.backward",
            title: nil,
            label: "Back to Note",
            id: "leave",
            action: { pressed("leave") }
        )
        return bar(row: row, trailing: back)
    }

    private static func button(
        symbol: String?,
        title: String?,
        label: String,
        id: String,
        action: @escaping () -> Void
    ) -> UIButton {
        let button = UIButton(type: .system)
        if let symbol { button.setImage(UIImage(systemName: symbol), for: .normal) }
        if let title {
            button.setTitle(title, for: .normal)
            // Monospaced, because these two are terminal notation and read as
            // such: the caret is a key name here, not punctuation.
            button.titleLabel?.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        }
        // The label is what VoiceOver reads: an SF Symbol has no name a screen
        // reader can use, and a row of unlabelled glyphs is the worst case for
        // one.
        button.accessibilityLabel = label
        button.accessibilityIdentifier = id
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    /// The shared geometry: an equally-divided row, and one fixed 44-point
    /// button at the trailing edge. Both faces are built this way so that
    /// swapping them cannot move anything under a thumb already on its way
    /// down.
    private static func bar(row: [UIButton], trailing: UIButton) -> UIView {
        let bar = BarView()
        bar.frame = CGRect(x: 0, y: 0, width: 0, height: 44)
        // The keyboard sets the width; the height is ours and 44 is the touch
        // target UIKit uses everywhere else.
        bar.autoresizingMask = .flexibleWidth

        let keys = UIStackView(arrangedSubviews: row)
        keys.axis = .horizontal
        keys.distribution = .fillEqually
        trailing.setContentHuggingPriority(.required, for: .horizontal)

        let stack = UIStackView(arrangedSubviews: [keys, trailing])
        stack.axis = .horizontal
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: bar.topAnchor),
            stack.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
            // Inset, so the outermost buttons are not against the bezel where a
            // thumb reaching for them catches the screen edge instead.
            stack.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -4),
            trailing.widthAnchor.constraint(equalToConstant: 44),
        ])
        return bar
    }

    /// A toolbar-ish background that reads as part of the keyboard rather than
    /// as part of the page.
    private final class BarView: UIInputView {
        init() {
            super.init(frame: .zero, inputViewStyle: .keyboard)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("no storyboard") }
    }
}

/// The closure the getter calls, boxed so it can hang off a view.
private final class AccessoryProvider {
    let make: () -> UIView?
    init(_ make: @escaping () -> UIView?) { self.make = make }
}

/// Its association key. The address is the key; the value is never read.
private var accessoryProviderKey: UInt8 = 0

extension WKWebView {
    /// Give the web view's editing surface an accessory view.
    ///
    /// **The awkward part, and why it is done this way.** The first responder
    /// while you type in a web page is not this `WKWebView` — it is a private
    /// content view inside its scroll view, so overriding `inputAccessoryView`
    /// on a WKWebView subclass gets you a method UIKit never calls. The way
    /// every app that ships a bar over a web view does it is the way below: at
    /// run time, make a subclass of whatever class that content view actually
    /// is, give the subclass an `inputAccessoryView` that returns ours, and
    /// re-point the instance at it.
    ///
    /// No private API is *named* here — the class is discovered from the live
    /// object rather than looked up by a hardcoded string — and every step can
    /// fail without consequence: a miss returns nil and the app runs with the
    /// system's own bar, which is what it had before. That matters more than
    /// usual, because the alternative failure is a crash on the first keystroke.
    ///
    /// `provider` is asked every time UIKit wants the bar rather than being
    /// captured as a view, because that content view is the first responder for
    /// EVERY text field in the page — the search box, a rename, a passphrase,
    /// a running block's terminal — and a formatting bar over any of them is a
    /// row of buttons that would act on the note behind it. Which face comes
    /// back is `WebHost`'s, and it is told by the page (ios.md §7); nil is left
    /// for the case where there is no host at all, since a keyboard with no way
    /// to dismiss it is worse than the wrong verbs over one.
    ///
    /// Answers the view whose `reloadInputViews()` re-asks, since the responder
    /// does not change when focus moves between two fields on one page.
    @discardableResult
    func installAccessoryView(_ provider: @escaping () -> UIView?) -> UIView? {
        // Only after the first load: the content view does not exist until the
        // web view has something to show. Matched on the class name of the live
        // object, which is why this is a `contains` and not an `NSClassFromString`
        // — the name is an observation about what is on screen, not a symbol
        // this binary links against.
        guard
            let content = scrollView.subviews.first(where: {
                String(describing: type(of: $0)).contains("ContentView")
            })
        else { return nil }

        // On the view, not in the class. A class pair can be registered once
        // under one name and never again, so a closure baked into the getter
        // below would answer for the FIRST web view this process ever built —
        // and there is a second whenever pairing swaps the root controller out
        // (a host key that changed, a server list emptied). It would not fail
        // loudly either: the old `WebHost` is kept alive by the message handler
        // its web view retains, so the getter would go on reading a `face` that
        // nothing updates any more, and the whole bar would be missing, Hide
        // Keyboard included, until the app was killed.
        objc_setAssociatedObject(
            content,
            &accessoryProviderKey,
            AccessoryProvider(provider),
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )

        let name = "LedgeAccessoryContentView"
        if let already = NSClassFromString(name) {
            object_setClass(content, already)
            return content
        }

        guard let base = object_getClass(content),
            let subclass = objc_allocateClassPair(base, name, 0)
        else { return nil }

        // The getter UIKit asks the first responder for. It reads the provider
        // off the receiver rather than closing over one, for the reason above.
        let getter: @convention(block) (AnyObject) -> UIView? = { receiver in
            (objc_getAssociatedObject(receiver, &accessoryProviderKey) as? AccessoryProvider)?.make()
        }
        let selector = #selector(getter: UIResponder.inputAccessoryView)
        guard let template = class_getInstanceMethod(UIResponder.self, selector) else {
            objc_disposeClassPair(subclass)
            return nil
        }
        class_addMethod(
            subclass,
            selector,
            imp_implementationWithBlock(getter),
            method_getTypeEncoding(template)
        )
        objc_registerClassPair(subclass)
        object_setClass(content, subclass)
        return content
    }
}
