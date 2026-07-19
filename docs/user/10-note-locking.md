# Note Locking

Locking encrypts a note's body on disk behind a passphrase. It exists in this order for three audiences: agents (Ledge deliberately points AI tools at your notes, and a locked body is never available to them, even while you have the note open), sync services (a locked note leaves the machine as ciphertext), and anyone at your screen (locked notes need an unlock to read).

## Locking a note

Run "Lock This Note…" from the command palette. The very first lock sets up the vault: you choose a passphrase, typed twice, and the dialog states the contract in one sentence, because it matters: there is no recovery. A forgotten passphrase is the note's body, gone.

Locking an existing note also seals the images it references (a screenshot pasted into a sensitive note is routinely the most sensitive thing in it), and the dialog reminds you of one honest limit: versions of the note that a sync service or backup captured before the lock stay whatever they were. Only a note born locked has a clean history.

"Remove Lock…" is the way back: it decrypts the note (and its images, unless another locked note still uses them) behind one confirmation, because the consequence is exposure: the next sync or agent scan sees the body.

## Locked and unlocked

One passphrase covers all locked notes, app-wide. Opening a locked note while the vault is shut asks for it right there; a wrong passphrase shakes and lets you retry, and "Unlock Notes…" in the palette asks proactively. Once unlocked, every locked note reads and edits like a normal note, and saves go back to disk encrypted.

⌘L is the walking-away gesture: Lock Notes relocks the vault immediately. The vault also relocks itself after 15 minutes of inactivity. Locked notes' rows wear a lock glyph in the sidebar and ⌘P, drawn open while the vault is unlocked, so "readable right now" is visible without opening anything.

"Change Vault Passphrase…" rewraps every locked note under the new passphrase (contents untouched) and reports how many it found. And a locked note is self-contained: synced to another machine, it unlocks with the passphrase alone.

## What stays visible

Stated plainly so nothing surprises you later:

- The title, as the filename and H1, everywhere titles appear: sidebar, ⌘P, wikilinks. That is what keeps navigation and linking working without decryption. If the title itself is the secret, title the note blandly.
- The frontmatter, including tags: a tag on a locked note still shows in the tags panel.
- That the file exists, its size, and its modification time.

Full-text search, backlinks, and tags scans skip locked bodies, and the panels say how many notes they skipped, so a partial answer is visibly partial rather than quietly wrong (see [[Finding Things]]).

## Locking and everything else

Agent surfaces ([[Agents and Ledge]]) refuse locked bodies by construction: reading a locked note over MCP or the CLI returns a refusal, listings flag locked notes so agents can plan around them, and `prompt` fences in a locked note render with their run buttons disabled, since their whole job is sending the body to an agent. Other code blocks in a locked note still run: the commands in a locked ops note are your own compute, and running them is the point.

A locked note cannot be a template (a template's body exists to be stamped into new notes, the opposite of locked), and the `locked:` frontmatter line is machine-owned: deleting it in the editor does not decrypt anything; only "Remove Lock…" does.

And the honest boundary: locking protects notes at rest and from the software Ledge itself invites in. It is not a defense against malware running as you or a stolen machine that is already unlocked. FileVault is the answer for stolen hardware; locking rides on top of it, not instead of it.
