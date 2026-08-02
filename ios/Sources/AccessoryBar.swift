import ObjectiveC
import UIKit
import WebKit

/// The strip above the keyboard, and the six command ids on it (ios.md §7).
///
/// ⌘B, ⌘I, ⌘K and Tab are chords, and a phone has none: the iPhone software
/// keyboard does not even have a Tab key, so indent and outdent are not merely
/// awkward there, they are unreachable. This is where they go.
///
/// **It carries ids, not behavior.** A tap posts `{t: "verb", id: ...}` across
/// the bridge and the page's command registry decides what that means, exactly
/// as the Mac's menu bar does (mainview/lib/menu.ts). So a renamed command
/// leaves a button that does nothing and logs why, rather than one that
/// quietly does something else — and Swift never grows a second opinion about
/// what "bold" is.
///
/// **HTML was the alternative and §7 rules it out.** A bar drawn in the page
/// has to track the visual viewport for the life of the app: every keyboard
/// animation, every rotation, every scroll of a focused field. `inputAccessoryView`
/// is attached to the keyboard by the system and needs none of that.
enum AccessoryBar {
    /// Left to right. Outdent before indent because that is the order they sit
    /// in on every toolbar that has both, and the pair before the formatting
    /// trio because they act on the line rather than on the selection.
    private static let buttons: [(id: String, symbol: String, label: String)] = [
        ("format.outdent", "decrease.indent", "Outdent"),
        ("format.indent", "increase.indent", "Indent"),
        ("format.bold", "bold", "Bold"),
        ("format.italic", "italic", "Italic"),
        ("format.link", "link", "Insert Link"),
        // The `[[` picker. Typed on a desktop, and typeable here too — the
        // point is that it takes two taps on a bracket key that lives behind
        // the software keyboard's second page.
        ("format.wikiLink", "text.append", "Link to Note"),
        // The photo library. Last because it is the one that leaves: it puts a
        // system picker over the whole app, where the five before it are edits
        // that happen under the thumb (ios.md §11).
        ("image.insert", "photo.on.rectangle", "Insert Image"),
    ]

    /// Build the strip. `tapped` is called with the command id; `dismiss` is
    /// the one button that is not a command.
    static func make(tapped: @escaping (String) -> Void, dismiss: @escaping () -> Void) -> UIView {
        let bar = BarView()
        bar.frame = CGRect(x: 0, y: 0, width: 0, height: 44)
        // The keyboard sets the width; the height is ours and 44 is the touch
        // target UIKit uses everywhere else.
        bar.autoresizingMask = .flexibleWidth

        let verbs = UIStackView()
        verbs.axis = .horizontal
        verbs.distribution = .fillEqually
        for (id, symbol, label) in buttons {
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: symbol), for: .normal)
            // The label is what VoiceOver reads: an SF Symbol has no name a
            // screen reader can use, and a row of six unlabelled glyphs is the
            // worst case for one.
            button.accessibilityLabel = label
            button.accessibilityIdentifier = id
            button.addAction(UIAction { _ in tapped(id) }, for: .touchUpInside)
            verbs.addArrangedSubview(button)
        }

        // Not a command, and apart from the six. Nothing else on this screen
        // puts the keyboard away: the editor fills the window, so there is no
        // blank page to tap, and tapping the chrome does not blur a
        // contenteditable. Without this the keyboard takes a third of the phone
        // for the rest of the session, which is why every iOS accessory bar
        // that ships has one.
        let down = UIButton(type: .system)
        down.setImage(UIImage(systemName: "keyboard.chevron.compact.down"), for: .normal)
        down.accessibilityLabel = "Hide Keyboard"
        down.accessibilityIdentifier = "keyboard.hide"
        down.addAction(UIAction { _ in dismiss() }, for: .touchUpInside)
        down.setContentHuggingPriority(.required, for: .horizontal)

        let stack = UIStackView(arrangedSubviews: [verbs, down])
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
            down.widthAnchor.constraint(equalToConstant: 44),
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
    /// EVERY text field in the page — the search box, a rename, a passphrase —
    /// and a formatting bar over a search box is a row of buttons that would act
    /// on the note behind it. Returning nil is how the bar declines to appear;
    /// what asks is `WebHost`, which is told by the page (ios.md §7).
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

        let name = "LedgeAccessoryContentView"
        if let already = NSClassFromString(name) {
            object_setClass(content, already)
            return content
        }

        guard let base = object_getClass(content),
            let subclass = objc_allocateClassPair(base, name, 0)
        else { return nil }

        // The getter UIKit asks the first responder for. The closure is
        // captured, not the view: §5 makes foregrounding a reload, and the class
        // is registered once for the life of the process, so what is baked in
        // here has to outlive every page this shell will ever load.
        let getter: @convention(block) (AnyObject) -> UIView? = { _ in provider() }
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
