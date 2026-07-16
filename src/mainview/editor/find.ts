import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";

// Find / replace on top of @codemirror/search. The stock panel always shows both
// a find and a replace row in a loose inline layout; we supply a custom `Panel`
// instead: a tidy toolbar that opens find-only and expands the replace row on
// demand (the conventional "find, with replace one click away" shape), themed to
// the app chrome in setup.ts.

// The live panel for a given view, so the "open with replace" command can reach
// the instance and expand its replace row. Keyed by view because split panes can
// each have a panel open at once.
const panels = new WeakMap<EditorView, SearchPanel>();

// Terse DOM builder: className + a bag of properties assigned straight onto the
// node (textContent, value, placeholder, type, checked, title, onclick, ...).
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  props: Record<string, unknown> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  Object.assign(node, props);
  return node;
}

class SearchPanel implements Panel {
  dom: HTMLElement;
  top = true;

  private findField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private caseBox: HTMLInputElement;
  private reBox: HTMLInputElement;
  private wordBox: HTMLInputElement;
  private replaceRow: HTMLElement;
  private toggle: HTMLButtonElement;
  private allBtn!: HTMLButtonElement;
  private allActive = false;
  private query: SearchQuery;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);

    // A checkbox rendered as a small labelled pill (match case / regexp / word).
    const check = (label: string, title: string, checked: boolean) => {
      const input = make("input", "", { type: "checkbox", checked });
      const wrap = make("label", "ledge-search-check", { title });
      wrap.append(input, document.createTextNode(label));
      return { input, wrap };
    };
    const btn = (text: string, cls: string, title: string, onclick: () => void) =>
      make("button", cls, { type: "button", textContent: text, title, onclick });

    // Search fields must take text verbatim: macOS WKWebView otherwise applies
    // autocorrect/autocapitalize/spellcheck to a plain <input> and mangles the
    // query (capitalises "sh" to "Sh", "fixes" spellings). autocorrect is a
    // WebKit-only attribute with no IDL property, so it needs setAttribute.
    const field = (placeholder: string, value: string) => {
      const el = make("input", "ledge-search-field", { placeholder, value, spellcheck: false });
      el.setAttribute("autocorrect", "off");
      el.setAttribute("autocapitalize", "off");
      el.setAttribute("autocomplete", "off");
      return el;
    };

    // --- find row ---
    this.toggle = btn("›", "ledge-search-btn ledge-search-toggle", "Toggle replace", () =>
      this.toggleReplace(),
    );
    this.findField = field("Find", this.query.search);
    const prev = btn("↑", "ledge-search-btn", "Previous match (⇧Enter)", () => findPrevious(this.view));
    const next = btn("↓", "ledge-search-btn", "Next match (Enter)", () => findNext(this.view));
    this.allBtn = btn("All", "ledge-search-btn", "Select all matches (toggle)", () => this.toggleAll());
    const all = this.allBtn;

    const cs = check("Aa", "Match case", this.query.caseSensitive);
    const re = check(".*", "Regular expression", this.query.regexp);
    const wd = check("W", "Whole word", this.query.wholeWord);
    this.caseBox = cs.input;
    this.reBox = re.input;
    this.wordBox = wd.input;
    const toggles = make("div", "ledge-search-toggles");
    toggles.append(cs.wrap, re.wrap, wd.wrap);

    const close = btn("×", "ledge-search-btn ledge-search-close", "Close (Esc)", () => {
      closeSearchPanel(this.view);
      this.view.focus();
    });

    const findRow = make("div", "ledge-search-row");
    findRow.append(this.toggle, this.findField, prev, next, all, toggles, close);

    // --- replace row (hidden until the chevron is toggled) ---
    const gutter = make("div", "ledge-search-gutter"); // aligns the field under the find field
    this.replaceField = field("Replace", this.query.replace);
    const repl = btn("Replace", "ledge-search-btn", "Replace next match", () => replaceNext(this.view));
    const replAll = btn("All", "ledge-search-btn", "Replace all matches", () => replaceAll(this.view));
    this.replaceRow = make("div", "ledge-search-row");
    this.replaceRow.hidden = true;
    this.replaceRow.append(gutter, this.replaceField, repl, replAll);

    this.dom = make("div", "ledge-search");
    this.dom.append(findRow, this.replaceRow);

    this.findField.addEventListener("input", () => this.commit());
    this.replaceField.addEventListener("input", () => this.commit());
    for (const b of [this.caseBox, this.reBox, this.wordBox]) b.addEventListener("change", () => this.commit());
    this.findField.addEventListener("keydown", (e) => this.onKey(e, false));
    this.replaceField.addEventListener("keydown", (e) => this.onKey(e, true));

    panels.set(view, this);
  }

  destroy() {
    panels.delete(this.view);
  }

  // Push the current field state into the shared search query. Guarded so an
  // identical commit (e.g. a keystroke that did not change the text) is a no-op.
  private commit() {
    const q = new SearchQuery({
      search: this.findField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseBox.checked,
      regexp: this.reBox.checked,
      wholeWord: this.wordBox.checked,
    });
    if (q.eq(this.query)) return;
    this.query = q;
    this.view.dispatch({ effects: setSearchQuery.of(q) });
  }

  private onKey(e: KeyboardEvent, inReplace: boolean) {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") {
      e.preventDefault();
      if (inReplace) (e.shiftKey ? replaceAll : replaceNext)(this.view);
      else (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(this.view);
      this.view.focus();
    } else if (mod && k === "g") {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (mod && (e.altKey || e.shiftKey) && k === "f") {
      // Cmd-Alt-F / Cmd-Shift-F while in the panel: expand the replace row.
      e.preventDefault();
      this.showReplace();
    } else if (mod && k === "f") {
      // Cmd-F while already in the panel: re-focus and select the find field.
      e.preventDefault();
      this.findField.focus();
      this.findField.select();
    }
  }

  private setReplace(show: boolean) {
    this.replaceRow.hidden = !show;
    this.toggle.classList.toggle("open", show);
  }

  private toggleReplace() {
    const show = this.replaceRow.hidden;
    this.setReplace(show);
    if (show) {
      this.replaceField.focus();
      this.replaceField.select();
    } else {
      this.findField.focus();
    }
  }

  // "All" is a toggle: on selects every match (multi-cursor), off collapses back
  // to a single caret. The lit state tracks whether all matches are currently
  // selected; update() clears it the moment the selection or query moves out from
  // under us, so the light never lies.
  private toggleAll() {
    if (this.allActive) {
      this.view.dispatch({ selection: { anchor: this.view.state.selection.main.head } });
      this.setAllActive(false);
    } else {
      selectMatches(this.view);
      // Only latch on if it actually produced a multi-selection (there were matches).
      this.setAllActive(this.view.state.selection.ranges.length > 1);
    }
    // Focus the editor so the (multi-)selection is visible and typeable, rather
    // than rendering dimmed while focus stays in the panel.
    this.view.focus();
  }

  private setAllActive(on: boolean) {
    if (this.allActive === on) return;
    this.allActive = on;
    this.allBtn.classList.toggle("active", on);
    this.allBtn.setAttribute("aria-pressed", String(on));
  }

  // Expand the replace row and put the caret in it (used by the Cmd-Alt-F command).
  showReplace() {
    this.setReplace(true);
    this.replaceField.focus();
    this.replaceField.select();
  }

  // Reflect a query set elsewhere (e.g. "search for selection") into the fields.
  update(u: ViewUpdate) {
    for (const tr of u.transactions) {
      for (const ef of tr.effects) {
        if (ef.is(setSearchQuery) && !ef.value.eq(this.query)) {
          this.query = ef.value;
          if (this.findField.value !== ef.value.search) this.findField.value = ef.value.search;
          if (this.replaceField.value !== ef.value.replace) this.replaceField.value = ef.value.replace;
          this.caseBox.checked = ef.value.caseSensitive;
          this.reBox.checked = ef.value.regexp;
          this.wordBox.checked = ef.value.wholeWord;
          // A new query invalidates any all-matches selection: unlatch "All".
          this.setAllActive(false);
        }
      }
    }
    // Clear "All" the moment the selection or doc moves under us for any reason
    // other than our own select-all (a click, a keystroke, an edit), so the lit
    // state stays truthful.
    if ((u.selectionSet || u.docChanged) && !u.transactions.some((tr) => tr.isUserEvent("select.search.matches"))) {
      this.setAllActive(false);
    }
  }

  mount() {
    this.findField.focus();
    this.findField.select();
  }
}

// Open the panel (if closed) and expand its replace row. openSearchPanel dispatches
// synchronously, so by the time it returns the panel is mounted and registered.
function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  panels.get(view)?.showReplace();
  return true;
}

// We bind an explicit subset of bindings rather than the stock `searchKeymap`:
// that set binds Mod-d to selectNextOccurrence, but Ledge's window-level shortcut
// handler (App.tsx) owns Cmd-D for "split pane", and CodeMirror does not stop the
// keydown propagating, so shipping Mod-d here would fire both. These bindings act
// when focus is in the editor body; the panel handles its own keys once focused.
// Mod-Alt-f (Cmd-Option-F) is the conventional macOS "find & replace" opener, but
// cmux registers it as a system-global hotkey, so it never reaches us while cmux
// runs. Mod-Shift-f is the working fallback; both open the panel with replace
// expanded, so the correct chord still lights up on machines without cmux.
//
// The Shift variant is expressed as the `shift` handler on the Mod-f binding, not
// a standalone "Mod-Shift-f" key: a shifted letter arrives as key "F", which CM's
// name matching does not resolve to a "Mod-Shift-f" binding. The `shift` handler
// is CM's intended mechanism for this (the same pattern as Mod-g's shift below).
const findKeymap = Prec.highest(
  keymap.of([
    { key: "Mod-f", run: openSearchPanel, shift: openReplace },
    { key: "Mod-Alt-f", run: openReplace },
    { key: "Mod-g", run: findNext, shift: findPrevious, preventDefault: true },
    { key: "F3", run: findNext, shift: findPrevious, preventDefault: true },
    { key: "Escape", run: closeSearchPanel },
  ]),
);

export function findReplace() {
  return [
    // "Select all matches" produces a multi-range selection, which CodeMirror
    // drops to a single range unless this is enabled (drawSelection, already in
    // setup.ts, renders the extra cursors).
    EditorState.allowMultipleSelections.of(true),
    search({ createPanel: (view) => new SearchPanel(view) }),
    // Dim-highlight other occurrences of the current selection as you move around.
    highlightSelectionMatches(),
    findKeymap,
  ];
}
