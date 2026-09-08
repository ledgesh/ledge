// The unified quick-open overlay: one component, three modes.
//
// ⌘P opens notes mode (fuzzy-open a note by title, the old QuickOpen), ⇧⌘P
// commands mode (every palette-visible command with its key chip), ⌥⌘P search
// mode (full-text over note bodies, via the noteSearch RPC). Notes and search
// cover the selected workspace only, the way the note browser does. Notes are
// local to their workspace. In notes mode a leading ">" switches to commands
// (the VS Code convention) and a leading "#" to search. Backspace over the
// sigil returns to notes. Only the first character typed switches the mode, so
// a note whose title contains either character stays findable and the direct
// chords always land in their mode.
//
// The three modes are also a row of chips under the field. On a touch client
// that row is the only way across, and it is the discoverable path
// interactions.md §1a asks every verb to have. The sigils and the chords are
// the accelerator. A chip carries the query across with it. Retyping is the
// expensive act wherever the keyboard is on screen.
//
// A scope narrows the note rows and the text hits to one folder of the
// workspace (Search in Folder on a folder row). Commands are not scoped. The
// scope belongs to the overlay rather than to a mode, so the chips carry it
// across the way they carry the query. It shows as a removable pill in the
// field, and that is its whole state on screen: a scoped search that found
// nothing must not read as a workspace that holds nothing.
//
// A search whose query starts with "#" also lists tags. Rows prefix-matching
// the workspace's tag directory render above the text hits. A #tag is text too,
// so the hits below still find its occurrences. Enter on a tag row routes to
// the Tags panel drilled into it (tag.open). There is no fourth mode and no
// second sigil: tags are written with the "#" the search sigil already spends.
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Command as CommandIcon, FileText, Folder, Hash, LayoutTemplate, Lock, LockOpen, TextSearch, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { softKeyboard } from "@/lib/shell";
import { notesOf, useWorkspace } from "@/workspace/store";
import { useVaultState } from "@/vault/channel";
import { CHORD_BOOST, filterNotes, fuzzyFilter } from "@/notes/fuzzy";
import { FolderLabel, folderIndex } from "@/notes/FolderLabel";
import { listTags, searchNotes, type SearchHit } from "@/notes/channel";
import { normalizeTag, type TagInfo } from "../../shared/tags";
import { notesUnder } from "../../shared/folders";
import { requestReveal } from "@/workspace/editorPool";
import { pushLayer } from "./layers";
import { useCommands } from "./CommandProvider";
import { paletteItems, type PaletteItem } from "./registry";

export type OverlayMode = "notes" | "commands" | "search";

// The chips, and the whole of what a mode is on screen. Each wears the icon
// its own rows wear below: the picker and the results must agree on what kind
// of thing is being looked for. Each names the character that crosses to it,
// on the clients where that character is one keystroke. The search chip reads
// "Text" rather than "Search" because all three modes search and only the
// thing searched through differs. "Text" is also short enough for three chips
// to share one panel about 350 points wide on a phone.
const MODES: { id: OverlayMode; label: string; sigil: string | null; Icon: LucideIcon }[] = [
  { id: "notes", label: "Notes", sigil: null, Icon: FileText },
  { id: "commands", label: "Commands", sigil: ">", Icon: CommandIcon },
  { id: "search", label: "Text", sigil: "#", Icon: TextSearch },
];

// How long a keystroke burst runs before the RPC fires. Short enough that
// results feel live, long enough that typing "shipping" costs one scan rather
// than eight.
const SEARCH_DEBOUNCE_MS = 80;

export function Overlay({
  initialMode,
  // Seeds the input as plain filter text. The sigil branch below never sees it:
  // sigils fire only on the first character typed in notes mode, and the one
  // seeded open (note.fromTemplate's pre-filter) lands in commands mode.
  initialQuery = "",
  // The folder the overlay opens narrowed to, "" for the whole workspace.
  initialFolder = "",
  onClose,
}: {
  initialMode: OverlayMode;
  initialQuery?: string;
  initialFolder?: string;
  onClose: () => void;
}) {
  const { state, dispatch, selected } = useWorkspace();
  const { exec, commands, ctx } = useCommands();
  // A locked row's glyph opens while the vault is unlocked, as in NoteBrowser.
  const vaultOpen = useVaultState() === "unlocked";
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState(initialFolder);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The mode when no sigil is spelling one: what a chord opened the overlay in,
  // or what a chip last picked. The sigil below overrides it, so Backspace over
  // the sigil comes back here.
  const [base, setBase] = useState(initialMode);
  // The sigils only fire as the first character of notes mode; the direct
  // chords are unconditional.
  const sigil = base === "notes" ? (query.startsWith(">") ? "commands" : query.startsWith("#") ? "search" : null) : null;
  const mode: OverlayMode = sigil ?? base;
  const isCommands = mode === "commands";
  const isSearch = mode === "search";
  // Commands live in no folder, so the pill is hidden in commands mode rather
  // than drawn over a list it does not narrow. The scope is kept, not dropped:
  // crossing back to Notes or Text shows the pill and its narrowed rows again.
  const showScope = scope !== "" && !isCommands;
  // Strip the mode-switch sigil before filtering; a direct chord open has none.
  const q = sigil ? query.slice(1) : query;

  const wsNotes = notesOf(state, selected.folder);
  // What the note rows are drawn from: the whole workspace, or one folder of it
  // and the folders inside it. Filtered in the view rather than by an RPC,
  // unlike the text search below, because the view already holds every title.
  const folderNotes = useMemo(() => notesUnder(wsNotes, scope), [wsNotes, scope]);
  const notes = useMemo(
    () => (mode === "notes" ? filterNotes(q, folderNotes) : []),
    [mode, q, folderNotes],
  );
  // Where each note lives, for the search rows: a hit carries a path and a
  // title but no folder, so the folder is looked up in the note list. Indexed
  // over the whole workspace rather than the scope, since the answer to "where
  // is this path" does not change with what is being looked at.
  const folders = useMemo(() => folderIndex(wsNotes), [wsNotes]);

  // The tag rows' vocabulary. listTags runs when search mode opens, and again
  // when the workspace or the scope changes, but not per keystroke: the
  // directory changes with the notes, not with the query. It takes the scope,
  // like the search below, so every row comes from the folder the overlay says
  // it is looking in. Enter on a tag row still lands in the Tags panel, which
  // is a workspace-wide surface.
  const [tags, setTags] = useState<TagInfo[]>([]);
  useEffect(() => {
    if (!isSearch) return;
    let stale = false;
    listTags(selected.folder, scope).then(
      (t) => {
        if (!stale) setTags(t.tags);
      },
      () => {
        if (!stale) setTags([]);
      },
    );
    return () => {
      stale = true;
    };
  }, [isSearch, selected.folder, scope]);

  // Tag rows show only for a query that starts with "#". A query that crossed
  // by sigil always does. A query typed after a direct ⌥⌘P opts in by spelling
  // the tag as written, and a bare "#" lists the whole directory.
  const tagPrefix = isSearch && query.startsWith("#") ? query.slice(1) : null;
  const tagRows = useMemo(() => {
    if (tagPrefix === null) return [];
    const want = normalizeTag(tagPrefix);
    return tags.filter((t) => normalizeTag(t.tag).startsWith(want));
  }, [tagPrefix, tags]);

  // Search mode asks Bun, debounced, and guards against answers landing out of
  // order: only the reply to the query still on screen may set the list.
  // `lockedSkipped` rides each answer and counts the locked notes the scan did
  // not read (locking.md §4). The footer below shows that count.
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [lockedSkipped, setLockedSkipped] = useState(0);
  useEffect(() => {
    if (!isSearch || q.trim() === "") {
      setHits([]);
      setLockedSkipped(0);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      searchNotes(selected.folder, q, scope).then(
        (h) => {
          if (stale) return;
          setHits(h.hits);
          setLockedSkipped(h.lockedSkipped);
        },
        () => {
          if (stale) return;
          setHits([]);
          setLockedSkipped(0);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [isSearch, q, selected.folder, scope]);
  const items = useMemo<PaletteItem[]>(() => {
    if (!isCommands) return [];
    const visible = paletteItems(commands, ctx());
    // An empty query shows the registry's own order (semantic grouping). A
    // query re-ranks by match quality and lifts chorded commands a notch,
    // since a chord marks a frequent act (CHORD_BOOST's rationale in fuzzy.ts).
    return q.trim()
      ? fuzzyFilter(q, visible, (i) => i.title, (i) => (i.chorded ? CHORD_BOOST : 0))
      : visible;
    // ctx() reads a ref; state/selected are the real inputs that change what
    // `when` and the dynamic titles produce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCommands, q, commands, state]);

  // In search mode the keyboard walks one list: tag rows first, text hits
  // after. The index arithmetic in open() and the render below agree on that.
  const count = isCommands ? items.length : isSearch ? tagRows.length + hits.length : notes.length;
  // A stale index from a longer result set would point past the end.
  const active = Math.min(index, Math.max(count - 1, 0));

  // Whether the overlay offers the crossing to search mode. It offers it in
  // notes mode when something is typed and no title matched. The crossing is
  // the one path across that needs no prior knowledge of a chip, a sigil or a
  // chord, and the row it draws below replaces the "No notes match" message.
  const crossing = mode === "notes" && q.trim() !== "" && notes.length === 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // This is a modal layer: Escape (capture, topmost-only) closes it, and the
  // window command dispatcher is suppressed while it is up.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => pushLayer("overlay", () => onCloseRef.current()), []);

  // Keep the highlighted row visible as the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, count]);

  // Cross to another mode, keeping what was typed. Crossing back to notes
  // strips a leading ">" or "#": the sigil branch above would otherwise read
  // it as another crossing and bounce straight back out. The focus stays in
  // the field, so a phone's software keyboard does not drop and rise again
  // (the chips' onMouseDown below is what holds it).
  const pick = (m: OverlayMode) => {
    if (m === mode) return;
    setBase(m);
    setQuery(m === "notes" ? q.replace(/^[>#]/, "") : q);
    setIndex(0);
    inputRef.current?.focus();
  };

  const open = (i: number) => {
    if (isCommands) {
      const item = items[i];
      if (!item) return;
      // Close first: commands that refocus the editor (Find, Run Block) need
      // the overlay's focus out of the way before they act.
      onClose();
      exec(item.id);
    } else if (isSearch) {
      if (i < tagRows.length) {
        const t = tagRows[i];
        if (!t) return;
        // Close first, like a command: tag.open lands in the Tags panel, and
        // the overlay's focus must be out of the way before it shows.
        onClose();
        exec("tag.open", { kind: "tag", tag: t.tag });
        return;
      }
      const hit = hits[i - tagRows.length];
      if (!hit) return;
      // The reveal is registered before the open: openNote's render is what
      // attaches (or creates) the editor the reveal lands in.
      requestReveal(hit.path, hit.line, q);
      dispatch({ type: "openNote", note: { path: hit.path, title: hit.title, mtimeMs: hit.mtimeMs }, preview: true });
      onClose();
    } else {
      const note = notes[i];
      if (!note) return;
      // Both rows navigate, so both open a preview tab (interactions.md §1b).
      dispatch({ type: "openNote", note, preview: true });
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(active + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === "Backspace" && showScope && query === "") {
      // Backspace in an empty field drops the scope, the same way it drops a
      // mode sigil. The pill is the leftmost thing in the field, so the key
      // that deletes leftwards is the one that removes it.
      e.preventDefault();
      setScope("");
      setIndex(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // The crossing row is the only row on screen when it shows, and it is
      // highlighted, so Enter runs it. Enter on an otherwise empty list does
      // nothing.
      if (crossing) pick("search");
      else open(active);
    }
    // Escape is handled by the layer stack (layers.ts), not here.
  };

  return (
    // The backdrop closes on click; the panel stops the click from reaching it.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[60vh] w-[min(520px,90vw)] flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* The field is a row once a scope can sit in it. The pill goes inside
            the field rather than above or below it, so the folder and the
            query read left to right as one question. */}
        <div className="flex shrink-0 items-center">
          {showScope && (
            // The whole pill removes the scope; the ✕ is not a separate
            // control. A ✕-only target would be about 24 points, which a
            // finger misses. A click on a scope has no other sensible meaning.
            // Backspace in an empty field removes it too (onKeyDown above).
            //
            // 32 points on touch rather than the 44 of interactions.md §1a.
            // The pill is a token inside a 44-point field: at 44 it would be
            // as tall as the field and stop reading as part of the query.
            // Backspace removes it on every software keyboard.
            <button
              type="button"
              data-testid="overlay-scope"
              // Take the tap without taking the focus, as the mode chips below
              // do, for the same reason: the caret belongs in the field.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setScope("");
                setIndex(0);
                inputRef.current?.focus();
              }}
              title={`Looking in ${scope} only. Click to search the whole workspace.`}
              className="ml-3.5 flex min-w-0 shrink items-center gap-1 rounded bg-secondary py-0.5 pl-1.5 pr-1 text-xs text-secondary-foreground touch:min-h-[32px]"
            >
              <Folder className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{scope}</span>
              <X className="size-3 shrink-0 text-muted-foreground" />
            </button>
          )}
          <input
            ref={inputRef}
            value={query}
            // The placeholder says what the field is for, and no longer
            // teaches the sigils: it read "Search notes  (> commands · # in
            // text)" before the chips existed. The chips teach the crossings
            // instead, each labelling the control that performs one, and they
            // stay on screen once typing starts.
            placeholder={isCommands ? "Run a command" : isSearch ? "Search inside notes" : "Search notes"}
            spellCheck={false}
            // WKWebView applies autocorrect and autocapitalize to a bare
            // <input> and mangles typed text ("sh" becomes "Sh"). `autocorrect`
            // is WebKit-only with no IDL property, hence the attribute-style
            // props here.
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
            // `min-w-0 flex-1` rather than `shrink-0`: the pill beside the
            // field may hold a long folder name, and a field that cannot
            // shrink would push itself off the panel instead of letting the
            // name truncate.
            className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm outline-none placeholder:text-muted-foreground touch:min-h-[44px]"
          />
        </div>

        {/* The three modes as three controls a finger chooses between, so 44
            points on touch (interactions.md §1a). The row makes the sigils an
            accelerator rather than the only way across. It sits under the field
            rather than over it: the field is what the overlay is for, and the
            caret stays at the top of the panel where every client's chord puts
            it.

            Tinted so the strip reads as chrome rather than as the first row of
            the list. The lit chip and the highlighted row are both a filled box
            two lines apart, and `--secondary` and `--accent` hold the same
            value in this theme, so the separation comes from the background
            they sit on. */}
        <div className="flex shrink-0 gap-1 border-y bg-muted/50 p-1">
          {MODES.map(({ id, label, sigil: key, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              // Take the tap without taking the focus: a chip that blurred the
              // field would drop the software keyboard and raise it again, and
              // on a Mac it would strand the caret outside the input the next
              // keystroke is meant for.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground touch:min-h-[44px] touch:text-sm",
                // `secondary`, not the `accent` the rows use, though the two
                // tokens hold the same value today. A lit chip says which of
                // three modes is on, the way the header's lit buttons do
                // (App.tsx); a lit row says where the keyboard is. Naming them
                // apart keeps each right if one token changes.
                mode === id && "bg-secondary text-secondary-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              {label}
              {/* The sigil, shown the way a palette row shows its key chip, and
                  absent rather than muted where the sigil is not one keystroke
                  (interactions.md §1a). `softKeyboard` rather than a media
                  query: the question is what the keyboard costs, and
                  lib/shell.ts already answers it. */}
              {key && !softKeyboard() && (
                <span className="text-[11px] text-muted-foreground">{key}</span>
              )}
            </button>
          ))}
        </div>

        {/* Every row below carries `touch:min-h-[44px]` (interactions.md §1a),
            and this list is where it matters most: on a client with no chords
            the overlay carries every command, reached from the header's
            magnifier since ⌘P is not typeable. The size is repeated in each of
            the four row kinds, which are four different shapes (a verb, a tag,
            a search hit, a note) rather than one component wearing four
            hats. */}
        <div ref={listRef} data-testid="overlay-list" className="min-h-0 flex-1 overflow-y-auto p-1">
          {count === 0 ? (
            crossing ? (
              // A row, not a message: the same shape as the search hits it
              // leads to, and highlighted because Enter runs it. It says what
              // it will look for, in the words that were typed.
              <div
                data-active=""
                data-crossing=""
                className="flex cursor-default items-center gap-2 rounded bg-accent px-2.5 py-1.5 touch:min-h-[44px]"
                onClick={() => pick("search")}
              >
                <TextSearch className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  Search “{q.trim()}” in note text
                </span>
              </div>
            ) : (
              <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
                {isCommands
                  ? "No matching commands"
                  : isSearch
                    ? q.trim() === ""
                      // "every note" claims a coverage a scoped overlay
                      // does not have.
                      ? showScope
                        ? `Type to search the text of the notes in ${scope}`
                        : "Type to search every note's text"
                      : "No matches"
                    : folderNotes.length === 0
                      ? "No notes yet"
                      : "No notes match"}
              </p>
            )
          ) : isCommands ? (
            items.map((item, i) => {
              const Icon = item.icon ?? CommandIcon;
              return (
                <div
                  key={item.id}
                  data-active={i === active ? "" : undefined}
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 touch:min-h-[44px]",
                    i === active && "bg-accent",
                  )}
                  // Highlight follows the pointer, so mouse and keyboard agree
                  // on what Enter would run.
                  onMouseMove={() => setIndex(i)}
                  onClick={() => open(i)}
                >
                  <Icon
                    className={cn(
                      "size-3.5 shrink-0",
                      item.destructive ? "text-destructive" : "text-muted-foreground",
                    )}
                  />
                  <span className={cn("min-w-0 flex-1 truncate text-sm", item.destructive && "text-destructive")}>
                    {item.title}
                  </span>
                  {item.chip && (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {item.chip}
                    </span>
                  )}
                </div>
              );
            })
          ) : isSearch ? (
            <>
              {tagRows.map((t, i) => (
                <div
                  key={`tag:${t.tag}`}
                  data-active={i === active ? "" : undefined}
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 touch:min-h-[44px]",
                    i === active && "bg-accent",
                  )}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => open(i)}
                >
                  <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">#{t.tag}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {t.count} {t.count === 1 ? "note" : "notes"}
                  </span>
                </div>
              ))}
              {hits.map((hit, hi) => {
                const i = hi + tagRows.length;
                // The snippet with its match set off: col/length index the query
                // inside it (shared/search.ts windows long lines around it).
                const len = q.trim().length;
                return (
                  <div
                    key={`${hit.path}:${hit.line}`}
                    data-active={i === active ? "" : undefined}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 touch:min-h-[44px]",
                      i === active && "bg-accent",
                    )}
                    onMouseMove={() => setIndex(i)}
                    onClick={() => open(i)}
                  >
                    <TextSearch className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {hit.snippet.slice(0, hit.col)}
                      <span className="rounded-[2px] bg-primary/15 font-medium text-foreground">
                        {hit.snippet.slice(hit.col, hit.col + len)}
                      </span>
                      {hit.snippet.slice(hit.col + len)}
                    </span>
                    <span className="flex max-w-[35%] shrink-0 items-baseline gap-1.5 truncate text-[11px] text-muted-foreground">
                      <span className="truncate">{hit.title}</span>
                      <FolderLabel folder={folders.get(hit.path)} />
                    </span>
                  </div>
                );
              })}
            </>
          ) : (
            notes.map((note, i) => (
              <div
                key={note.path}
                data-active={i === active ? "" : undefined}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 touch:min-h-[44px]",
                  i === active && "bg-accent",
                )}
                onMouseMove={() => setIndex(i)}
                onClick={() => open(i)}
              >
                {/* The NoteBrowser row's icon rule: a daily-role note wears
                    CalendarDays, any other template note LayoutTemplate, a
                    locked note Lock (open while the vault is unlocked). The
                    browser and the picker must agree on what kind a note is,
                    and on whether it is readable now. */}
                {note.template === "daily" ? (
                  <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
                ) : note.template ? (
                  <LayoutTemplate className="size-3.5 shrink-0 text-muted-foreground" />
                ) : note.locked ? (
                  vaultOpen ? (
                    <LockOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{note.title}</span>
                {/* Which of two same-titled notes this row is
                    (notes/FolderLabel.tsx). */}
                <FolderLabel folder={note.folder} />
              </div>
            ))
          )}
        </div>

        {/* The skipped notes are counted under the results, where their answer
            would have been: a search that silently omitted locked notes would
            read as "they don't mention it". One muted line, drawn only after a
            scan ran. */}
        {isSearch && q.trim() !== "" && lockedSkipped > 0 && (
          <p
            data-testid="search-locked-skipped"
            className="shrink-0 border-t px-3.5 py-1.5 text-[11px] text-muted-foreground"
          >
            {lockedSkipped} locked {lockedSkipped === 1 ? "note" : "notes"} not searched
          </p>
        )}
      </div>
    </div>
  );
}
