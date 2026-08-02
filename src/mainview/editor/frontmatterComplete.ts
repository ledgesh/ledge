// Completion inside the frontmatter block: the block teaches its own grammar
// at the moment of typing, the `[[` / `#` picker stance. Three vocabularies,
// all closed sets the view already holds:
// - key position (line start): the params keys, each with a one-line
//   hint — the popup is the documentation, so nobody greps for the grammar;
// - `template:` value: true / daily / false, with what each means;
// - `tags:` value: the workspace's own tags (the `#` picker's vocabulary via
//   the same bridge), and `host:` offers the reserved word "local".
// `profile:` completes nothing: the view has no profile list (profiles live
// outside the notes root, Bun-side), and the key's hint says where to look.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { splitTagList } from "../../shared/frontmatter";
import { workspaceTags } from "./bridge";
import { frontmatterLineSpan } from "./frontmatter";
import { sessionIdFacet } from "./session";

// Enough of a doc head to hold a frontmatter block (the app-wide cap).
const HEAD_BYTES = 4096;

// The params keys, shared/frontmatter.ts's grammar exactly. `apply` inserts
// the colon too (env opens its indented map), so accepting a key lands the
// caret where its value goes; `detail` is the one-line hint.
const KEY_OPTIONS: readonly Completion[] = [
  { label: "cwd", apply: "cwd: ", detail: "working directory for this note's shells" },
  { label: "profile", apply: "profile: ", detail: "named secrets file, kept outside the notes" },
  { label: "envFile", apply: "envFile: ", detail: "project dotenv file, resolved against cwd" },
  { label: "env", apply: "env:\n  ", detail: "inline vars (indented NAME: value lines)" },
  { label: "host", apply: "host: ", detail: "machines blocks run on (ssh targets, or local)" },
  { label: "tags", apply: "tags: ", detail: "this note's tags (also spelled inline as #tag)" },
  { label: "template", apply: "template: ", detail: "true joins the ⌥⌘N picker; daily seeds ⌘J" },
  { label: "confirm", apply: "confirm: ", detail: "true makes every block here ask before it runs" },
];

// true / false, and nothing else: the parser reports anything third as a typo.
const CONFIRM_VALUES: readonly Completion[] = [
  { label: "true", detail: "every runnable block asks first (a block may opt out with confirm=no)" },
  { label: "false", detail: "only blocks marked confirm on their fence ask" },
];

// Exactly the three values the parser accepts — anything else is a reported
// typo, so the popup lists the whole grammar.
const TEMPLATE_VALUES: readonly Completion[] = [
  { label: "true", detail: "a template; joins New Note from Template (⌥⌘N)" },
  { label: "daily", detail: "the template ⌘J instantiates for each day" },
  { label: "false", detail: "explicitly not a template" },
];

// The keys the block already declares on OTHER lines: offering `cwd` twice
// would just write a duplicate the parser resolves last-wins — noise, not
// help. The env map's indented lines are skipped; their names are free-form.
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
  // Body lines only: the fences are structure, and past the block this
  // source has nothing to say.
  if (line.number <= span.first || line.number >= span.last) return null;
  const before = state.sliceDoc(line.from, pos);

  // Key position: only letters between the line start and the caret. An
  // empty prefix pops on an explicit ask only — a fresh line inside the
  // block should not harass every pause.
  const key = /^([A-Za-z]*)$/.exec(before);
  if (key) {
    if (!key[1] && !context.explicit) return null;
    const declared = declaredKeys(state, span.last, line.number);
    const options = KEY_OPTIONS.filter((k) => !declared.has(k.label));
    if (options.length === 0) return null;
    return { from: line.from, options, validFor: /^[A-Za-z]*$/ };
  }

  const value = /^(template|confirm|tags|host)[ \t]*:([^]*)$/.exec(before);
  if (!value) return null;
  // "[" ends the token as a separator does: it opens a `tags:` flow sequence
  // (shared/frontmatter.ts unbracket), so it is punctuation the completion
  // must insert AFTER. Counting it into the token would put `from` on the
  // bracket itself and accepting an option would eat it — `tags: [` + work
  // has to become `tags: [work`, not `tags: work`.
  const token = /[^,\s[]*$/.exec(value[2]!)![0];

  if (value[1] === "template" || value[1] === "confirm") {
    const options = value[1] === "template" ? TEMPLATE_VALUES : CONFIRM_VALUES;
    return { from: pos - token.length, options, validFor: /^[A-Za-z]*$/ };
  }

  if (value[1] === "host") {
    // No host vocabulary view-side (ssh config is Bun's world); the one word
    // worth teaching is the reserved "local", once.
    const listed = value[2]!.split(/[,\s]+/).includes("local");
    if (listed) return null;
    return {
      from: pos - token.length,
      options: [{ label: "local", detail: "this machine (no ssh)" }],
      validFor: /^[A-Za-z]*$/,
    };
  }

  // tags: the workspace's directory, minus what the line already lists (the
  // parser would dedupe anyway — the popup shouldn't offer a no-op).
  const infos = workspaceTags(state.facet(sessionIdFacet));
  if (infos.length === 0) return null;
  // What is before the caret is a list still being typed, so an opening
  // bracket has no closer yet and splitTagList — which strips only a MATCHED
  // pair — would refuse `[work` and offer `work` a second time. Drop it here
  // rather than teaching the shared split about unbalanced brackets: in a
  // saved note an unclosed "[" really is the typo it looks like.
  const listed = value[2]!.replace(/^([ \t]*)\[/, "$1");
  const already = new Set(splitTagList(listed).accepted.map((a) => a.tag.toLowerCase()));
  already.delete((token.startsWith("#") ? token.slice(1) : token).toLowerCase());
  const options = infos
    .filter((t) => !already.has(t.tag.toLowerCase()))
    .map((t) => ({ label: t.tag, detail: String(t.count) }));
  if (options.length === 0) return null;
  return { from: pos - token.length, options, validFor: /^[^\s,]*$/ };
}
