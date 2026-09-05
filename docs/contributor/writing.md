# Ledge documentation style

Governs `docs/user/` (the manual compiled into the app) and the prose parts
of `docs/contributor/`. The reference model is the documentation developers
actually rate: Stripe, Tailwind, the Google developer documentation style
guide, and Diátaxis for structure. Those share one property this manual had
lost: **a reader scanning for a word finds it, and the sentence they land on
answers them.**

## 1. The failure mode this exists to stop

The manual drifted into essay voice: headings that describe a feeling
("Blocks that ask first", "Deleting is gentle", "The shell sticks around"),
sentences whose payload sits in the third clause, and design commentary
("deliberately", "on purpose", "the honest limit") standing in for the fact.
It reads well and answers badly. Someone looking for the confirmation feature
searches "confirm" and finds nothing.

Every rule below is a specific antidote to something that was in these pages.

## 2. Headings

**Name the feature, keyword first, sentence case.** A heading is an index
entry, not a caption. If a user would search for a word, that word goes in the
heading, ideally first.

| Was | Now |
| --- | --- |
| Blocks that ask first | Confirm before running |
| The shell sticks around | The shell persists between blocks |
| Deleting is gentle | Deleting a note |
| Auth is just ssh | Authentication |
| Made for pipes and agents | Piping and JSON output |
| Way one: talk in the note | Talk to an agent in a note |
| Peek behind the curtain | (delete: it labelled a code block) |

Prefer a noun phrase for reference sections ("Environment variables",
"The tokens") and a gerund for task sections ("Locking a note", "Attaching a
project"). Do not number `##` headings in `docs/user/`; do keep the numbering
in `docs/contributor/`, where sections get cited.

## 3. Lead with the answer

The first sentence of a section states what the thing is or does. Context,
rationale, and caveats come after, never before.

> **Don't:** Some blocks you want to think about twice. Write `confirm` after
> the language on the fence and Ledge puts a dialog between the chord and the
> shell.
>
> **Do:** Add `confirm` to a fence and Ledge asks before running the block.

Same rule at page scale: the opening paragraph says what the page covers in
plain terms, and skips the pitch.

## 4. One sentence, one idea

The dominant defect was the three-clause sentence that buries its subject.
Break it. A comma before "which is what", "so that", "because", or "and
which" is usually a period waiting to happen.

> **Don't:** Every shell this note spawns now starts in that directory with
> that environment, which is what turns a note into a control panel for one
> project: the blocks run where the code is.
>
> **Do:** Every shell the note spawns starts in that directory with that
> environment. The blocks run where the code is.

## 5. Mechanism before rationale, and cut most rationale

State what happens. Then, only if a user would otherwise think it a bug or
make a bad decision, say why. Design commentary is not documentation.

Ban list, unless the sentence genuinely fails without it: *deliberately, on
purpose, intentional, by design, worth knowing, the honest limit, stated
plainly, which is exactly right/wrong, the whole point.* Twenty-two instances
across sixteen short pages is the sound of a doc admiring itself.

Keep the why where it changes behavior: profiles are not sent to remote hosts
*because a secret on an ssh command line is visible in the remote process
table.* That one earns its clause.

## 6. No aphorisms, no personification

Software does not stick around, feel, degrade gently, die at birth, or buy
you anything. Cut the closing zinger from sections; it is the sentence most
likely to be wrong in six months and least likely to be read.

> **Don't:** There is no "don't ask again", because a remembered yes is
> exactly what the marker exists to prevent.
>
> **Do:** There is no "don't ask again". Every run asks.

> **Don't:** Git buys what git always buys: history for every note, diffs,
> branches, and hosting anywhere.
>
> **Do:** You get history, diffs, and branches for every note.

## 7. Voice

- Second person, present tense, active. "Ledge saves the image", not "the
  image is saved".
- Address the reader as *you*; the product as *Ledge*. Never *we*.
- Sentence case everywhere, including headings and UI labels quoted in prose.
- No em dashes (a standing rule for this repo). Use a period, a colon, or
  parentheses.

## 8. Facts belong in lists and tables

If a paragraph enumerates three or more things, it is a list. Keystrokes,
keys, verbs, and settings are reference data: make them scannable.

> **Don't:** `ls` lists notes, `search` prints `path:line: match` rows like
> grep (and exits nonzero on no hits, so it scripts like grep too), `cat`
> prints a note's markdown.
>
> **Do:** a table, one row per verb.

Front-load the shortcut: "⌘J opens today's note", not "To open today's note,
press ⌘J".

## 9. Keep the modes separate (Diátaxis)

Four modes, and a page commits to one:

- **Tutorial** (`13-` to `16-`): a sequence the reader follows to a working
  result. Numbered steps. No option surveys, no boundary discussion; link out
  instead.
- **How-to / reference** (`02-` to `12-`): what a feature is, every key and
  flag, ordered for lookup rather than for reading start to finish.
- **Explanation**: rationale and trade-offs. Gets its own final section on a
  page ("Limits", "What agents cannot see"), not a sentence smuggled into
  every paragraph.

The reference pages had drifted into tutorial voice ("Here is a live one,
harmless on purpose") and the tutorials into essay voice. Nothing in the
manual runs (§10), so a reference page *describes*: it shows what a note
contains and states what happens when it runs, in the indicative. A tutorial
*instructs*, and its instructions are carried out in the reader's own notes.

## 10. Mechanics for `docs/user/`

- One line per paragraph, no hard wrapping. The pages render in the editor,
  which soft-wraps; an 80-column wrap shows as broken lines mid-sentence.
  (`docs/contributor/` wraps at 80 as usual.)
- The H1 is the page title and the wikilink target. Changing it means
  updating every `[[Title]]` in the corpus, so change it only with reason.
- The manual describes; it never demonstrates. Nothing in it runs: every
  fence in a runnable language is marked `norun` on its opener
  (interactions.md §4e; `src/bun/docsContent.test.ts` fails on a page that
  forgets), and no sentence asks the reader to act on the page they are
  reading. Show an example as the contents of a note, in the indicative ("A
  note with these two blocks, run in order:"), and state the result in prose
  ("prints `/tmp`") rather than inviting the reader to see it. A block that
  only existed to be pressed is cut, not kept as decoration. Instructions
  that act in the reader's own notes ("press ⌘N", "run Attach Folder…") are
  fine. The reason nothing runs is
  where a manual page's shell would be: `$HOME` on whichever machine shows
  the page, this Mac or a phone's server, with no frontmatter, and the reader
  cannot see which.
- Link with `[[Page Title]]` on first substantive mention, not every mention.

## 11. The check

Before calling a page done, scan its `##` headings alone. If they do not read
as a table of contents that answers "can Ledge do X", the headings are wrong.
Then read the first sentence under each. If it does not answer the heading,
the section is wrong.
