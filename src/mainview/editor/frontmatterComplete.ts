// Completion inside the frontmatter block, the `[[` and `#` picker stance:
// three closed vocabularies the view already holds. The params keys at line
// start; the values of `template:`, `confirm:` and `favorite:`; the tags after
// `tags:` (the `#tag` vocabulary, same bridge) and "local" after `host:`.
// `profile:` completes nothing: the view holds no profile list. Profiles live
// outside the notes root, on the Bun side. The `profile` hint says so.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { splitTagList } from "../../shared/frontmatter";
import { workspaceTags } from "./bridge";
import { frontmatterLineSpan } from "./frontmatter";
import { sessionIdFacet } from "./session";

// Enough of a doc head to hold a frontmatter block (the app-wide cap).
const HEAD_BYTES = 4096;

// The keys shared/frontmatter.ts parses, apart from the machine-written
// `locked`. `apply` inserts the colon too (`env` opens its indented map), so
// accepting a key leaves the caret where the value goes. `detail` is the
// one-line hint the popup shows beside the key. The hints carry the grammar,
// so a writer does not have to go looking for it.
const KEY_OPTIONS: readonly Completion[] = [
  { label: "cwd", apply: "cwd: ", detail: "working directory for this note's shells" },
  { label: "profile", apply: "profile: ", detail: "named secrets file, kept outside the notes" },
  { label: "envFile", apply: "envFile: ", detail: "project dotenv file, resolved against cwd" },
  { label: "env", apply: "env:\n  ", detail: "inline vars (indented NAME: value lines)" },
  { label: "host", apply: "host: ", detail: "machines blocks run on (ssh targets, or local)" },
  { label: "tags", apply: "tags: ", detail: "this note's tags (also spelled inline as #tag)" },
  { label: "template", apply: "template: ", detail: "true joins the ⌥⌘N picker; daily seeds ⌘J" },
  { label: "confirm", apply: "confirm: ", detail: "true makes every block here ask before it runs" },
  { label: "favorite", apply: "favorite: ", detail: "true keeps this note in the sidebar's Favorites" },
];

// true and false, nothing else, for the two boolean keys. The parser reports
// any other value as a typo, so each popup lists that key's whole grammar.
const FAVORITE_VALUES: readonly Completion[] = [
  { label: "true", detail: "kept in the note browser's Favorites section" },
  { label: "false", detail: "explicitly not a favorite" },
];

const CONFIRM_VALUES: readonly Completion[] = [
  { label: "true", detail: "every runnable block asks first (a block may opt out with confirm=no)" },
  { label: "false", detail: "only blocks marked confirm on their fence ask" },
];

// The three values the parser accepts. It reports anything else as a typo,
// so the popup lists the whole grammar.
const TEMPLATE_VALUES: readonly Completion[] = [
  { label: "true", detail: "a template; joins New Note from Template (⌥⌘N)" },
  { label: "daily", detail: "the template ⌘J instantiates for each day" },
  { label: "false", detail: "explicitly not a template" },
];

// The keys the block already declares on other lines. Offering `cwd` twice
// would only write a duplicate. The parser takes the last one. `skipLine` is
// the line being completed, so its own key does not count. The loop skips
// indented lines: they belong to the env map, whose names are free-form.
function declaredKeys(
  state: CompletionContext["state"],
  last: number,
  skipLine: number,
): Set<string> {
  const seen = new Set<string>();
  for (let n = 2; n < last; n += 1) {
    if (n === skipLine) continue;
    const text = state.doc.line(n).text;
    if (/^[ \t]/.test(text)) continue;
    const colon = text.indexOf(":");
    if (colon > 0) seen.add(text.slice(0, colon).trim());
  }
  return seen;
}

/** Completion source for the frontmatter block, joined into appCompletion. */
export function frontmatterCompletionSource(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  const span = frontmatterLineSpan(state.sliceDoc(0, Math.min(HEAD_BYTES, state.doc.length)));
  if (!span) return null;
  const line = state.doc.lineAt(pos);
  // Body lines only. The fence lines are structure, and outside the block
  // this source has nothing to complete.
  if (line.number <= span.first || line.number >= span.last) return null;
  const before = state.sliceDoc(line.from, pos);

  // Key position: only letters between the line start and the caret. On an
  // empty prefix `context.explicit` gates the popup, so a fresh line inside
  // the block opens one only when the writer asks for it.
  const key = /^([A-Za-z]*)$/.exec(before);
  if (key) {
    if (!key[1] && !context.explicit) return null;
    const declared = declaredKeys(state, span.last, line.number);
    const options = KEY_OPTIONS.filter((k) => !declared.has(k.label));
    if (options.length === 0) return null;
    return { from: line.from, options, validFor: /^[A-Za-z]*$/ };
  }

  const value = /^(template|confirm|favorite|tags|host)[ \t]*:([^]*)$/.exec(before);
  if (!value) return null;
  // "[" ends the token, the way a separator does: it opens a `tags:` flow
  // sequence (shared/frontmatter.ts unbracket), so the completion inserts
  // after it. Counting it into the token would put `from` on the bracket.
  // Accepting an option would then replace it: `tags: [` plus work has to
  // become `tags: [work`, not `tags: work`.
  const token = /[^,\s[]*$/.exec(value[2]!)![0];

  if (value[1] === "template" || value[1] === "confirm" || value[1] === "favorite") {
    const options =
      value[1] === "template" ? TEMPLATE_VALUES : value[1] === "confirm" ? CONFIRM_VALUES : FAVORITE_VALUES;
    return { from: pos - token.length, options, validFor: /^[A-Za-z]*$/ };
  }

  if (value[1] === "host") {
    // The view holds no list of hosts (ssh configuration lives on the Bun
    // side), so the only option is the reserved word "local". The word drops
    // out once the text before the caret lists it.
    const listed = value[2]!.split(/[,\s]+/).includes("local");
    if (listed) return null;
    return {
      from: pos - token.length,
      options: [{ label: "local", detail: "this machine (no ssh)" }],
      validFor: /^[A-Za-z]*$/,
    };
  }

  // `tags:` offers the workspace's tags, minus the ones the text before the
  // caret lists. The parser drops such a repeat, so offering it would do
  // nothing.
  const infos = workspaceTags(state.facet(sessionIdFacet));
  if (infos.length === 0) return null;
  // The text before the caret is a list still being typed, so an opening
  // bracket has no closer yet. splitTagList strips only a matched pair, so it
  // refuses `[work` as a token. The popup would then offer `work` a second
  // time. The bracket comes off here rather than in the shared split: in a
  // saved note an unclosed "[" is the typo it looks like.
  const listed = value[2]!.replace(/^([ \t]*)\[/, "$1");
  const already = new Set(splitTagList(listed).accepted.map((a) => a.tag.toLowerCase()));
  already.delete((token.startsWith("#") ? token.slice(1) : token).toLowerCase());
  const options = infos
    .filter((t) => !already.has(t.tag.toLowerCase()))
    .map((t) => ({ label: t.tag, detail: String(t.count) }));
  if (options.length === 0) return null;
  return { from: pos - token.length, options, validFor: /^[^\s,]*$/ };
}
