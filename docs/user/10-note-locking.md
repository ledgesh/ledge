# Note Locking

Locking encrypts a note's body on disk behind a passphrase. It protects the note from three readers, in this order:

- **Agents.** Ledge points AI tools at your notes, and a locked body is never available to them, even while you have the note open.
- **Sync services.** A locked note leaves the machine as ciphertext.
- **Anyone at your screen.** Reading a locked note requires an unlock.

## Lock a note

Run "Lock This Note…" from the command palette.

The first lock sets up the vault. You choose a passphrase, typed twice, and the dialog states the contract: there is no recovery. A forgotten passphrase means the note's body is gone.

Locking a note also seals the images it references, since a screenshot pasted into a sensitive note is often the most sensitive thing in it.

One limit the dialog repeats: versions of the note that a sync service or backup captured before the lock are still plaintext wherever they were captured. Only a note that was locked from the start has a clean history.

## Remove a lock

"Remove Lock…" decrypts the note, and its images unless another locked note still uses them, behind one confirmation. After that the next sync or agent scan sees the body.

## Unlock and relock

One passphrase covers every locked note, app-wide.

- Opening a locked note while the vault is shut asks for the passphrase there. A wrong passphrase shakes and lets you retry.
- "Unlock Notes…" in the palette asks for it up front.
- ⌘L runs Lock Notes, which relocks the vault immediately. Use it when you walk away.
- The vault also relocks itself after 15 minutes of inactivity.

Once unlocked, every locked note reads and edits like a normal note, and saves go back to disk encrypted. Locked notes show a lock glyph in the sidebar and in ⌘P, drawn open while the vault is unlocked, so you can see what is readable without opening anything.

"Change Vault Passphrase…" rewraps every locked note under the new passphrase, leaving contents untouched, and reports how many it found.

A locked note is self-contained. Synced to another machine, it unlocks with the passphrase alone.

## What stays visible

Locking hides the body. It does not hide:

- **The title**, as the filename and the H1, everywhere titles appear: the sidebar, ⌘P, and wikilinks. This is what keeps navigation and linking working without decryption. If the title itself is the secret, give the note a bland one.
- **The frontmatter**, including tags. A tag on a locked note still shows in the tags panel.
- **The file's existence**, its size, and its modification time.

Full-text search, backlinks, and tag scans skip locked bodies. The panels report how many notes they skipped, so a partial answer looks partial ([[Finding Things]]).

## How locking interacts with the rest of Ledge

- **Agents** ([[Agents and Ledge]]) cannot read locked bodies. Reading a locked note over MCP or the CLI returns a refusal, and listings flag locked notes so agents can plan around them.
- **`prompt` fences** in a locked note have their run buttons disabled, since their job is to send the body to an agent.
- **Other code blocks** in a locked note still run. The commands in a locked ops note are yours to run.
- **Templates** cannot be locked. A template's body exists to be stamped into new notes.
- **The `locked:` frontmatter line** is machine-owned. Deleting it in the editor decrypts nothing; only "Remove Lock…" does.

## Limits

Locking protects notes at rest and from the software Ledge invites in. It does not defend against malware running as you, or against a stolen machine that is already unlocked. Use FileVault for stolen hardware. Locking sits on top of it, not instead of it.
