# Ledge on Your Phone

Ledge runs on an iPhone or iPad as a window onto a server. The phone holds no notes: it reaches a server over ssh, the way a Mac does in [[Keep Notes on a Remote Server]], and shows you what is there.

Set the server up first. "Install the server" on that page is the whole of it, and a server that already serves your Mac needs nothing more.

## Pair with a code

A pairing code names a server and its host keys, so the phone can add it without anyone typing an address or comparing a fingerprint. On the server, run:

```sh norun
ledge-server pair
```

It prints the code as a QR code, then the account, host, port, and host keys it holds, then the same code as a link. It reads the address from your ssh session, or uses the machine's name when there is no session. When the phone cannot reach the server by that name, give the address yourself with `--host`. `ledge-server pair --help` lists the other flags.

On the phone, tap Scan a pairing code at the top of "Pair with a server" and point the camera at the QR code. Scan it from Ledge rather than the Camera app, which opens the code in Safari. Ledge shows what the code names and connects only when you tap Connect. Choose how to sign in first, the same way as on the form below: with a key, whose line still has to be in the server's `authorized_keys`, or with a password. Ledge signs in only if the server offers one of the host keys in the code, so there is no fingerprint to check by eye.

The code holds no password and no key. Someone who photographs it learns where the server is and which account to try, and nothing that signs them in.

Opening a `ledge://pair` link on the phone shows the same screen, with a warning. A link can come from anyone, including someone running a server that only looks like yours, so connect only if the link came from your own server.

A code never replaces a host key the phone already has. When Ledge has a different key pinned for the same address, it refuses the code and keeps that key. If the server's key really changed, connect to it from the Servers list, where Ledge shows you the new key to check.

When the server runs in Docker, run `pair` on the machine that runs the container, since the host keys and the account the phone signs in to belong to that machine. Run inside the container, `ledge-server pair` prints the command to use instead.

## Pair with a server

The first launch opens on "Pair with a server". Scan a pairing code, at the top, opens the camera ("Pair with a code" above). Below it, the screen has three parts for adding a server by hand.

The first is a key line. On its first launch the phone makes a key of its own in the Secure Enclave, and that key never leaves the phone: there is no file to copy in or out. What leaves is the public half, as one line for the server's `~/.ssh/authorized_keys`:

```
restrict,command="ledge-server serve" ecdsa-sha2-nistp256 AAAA... ledge-iphone-3f2a91c0
```

Copy line puts it on the phone's pasteboard. Share line hands it to AirDrop, Messages, or any app that can carry it to a machine with a shell on the server, which is where the pasteboard on a phone falls short. Add it to `~/.ssh/authorized_keys` there. The comment at the end names the phone, so the line is easy to find again when you want to revoke it.

The line arrives already restricted, in the way "Restrict the key to Ledge" on [[Keep Notes on a Remote Server]] describes: the phone's key can speak Ledge's protocol and nothing else. It names `ledge-server` by its bare name, so the server has to be on the PATH an incoming ssh gets ("Check that ssh can find the server" on the same page). For the Docker deployment, change the command in the line to the `docker exec` form shown there.

The second part is the machine: `user@host`, and a port when sshd is not on 22. A phone reads no `~/.ssh/config`, so write the address out.

The third is Connect. The phone dials the server, shows its host key fingerprint, and asks "Is this the server?" alongside the command that prints the same fingerprint on the server. Trust pins the key, and a server that later presents a different one is refused, the same as on a Mac.

## Sign in with a password instead

Choose "A password" under Sign in with and type the password for that account. The phone keeps it in its own keychain, and no key line has to be installed.

The trade-off is the one described on [[Keep Notes on a Remote Server]]: a password reaches a fresh machine today, and a key is the better long-term answer. A server with `PasswordAuthentication no` refuses it.

## When the phone cannot reach its server

A server slow to answer shows "Connecting to user@host…" and, after a few seconds, a Choose a Different Server button.

A server that cannot be reached shows "Ledge could not reach a server." with the reason, then Try again and Choose a server. Try again comes first because the usual cause is the phone having moved networks, not the server having moved. Choose a server opens the Servers list, where you pick another one or add one.

A host key that has changed, or a key or password the server no longer accepts, lands you back on the pairing form with the address filled in. Retrying cannot fix either, so the pin is dropped and you compare the fingerprint again.

Removing the last server returns the phone to the pairing screen. Deleting the app deletes its key with it, so a reinstalled phone is a new device to every server and needs its line installed again.

## More than one server

Inside the app the connection bar works as on a Mac: tap it to add, edit, remove, or switch servers, with the same fingerprint step ([[Keep Notes on a Remote Server]]). The form shows the phone's key line where a Mac's shows a key path, with Share Line beside Copy Line.

A phone and a Mac can be on one server at once. Each keeps its own tabs, and a note's terminal has one owner between them.

## What a phone does

| On a phone | Not on a phone |
| --- | --- |
| Reading, editing, and creating notes, with live preview | The terminal drawer |
| Quick open, full-text search, tags, backlinks, the outline | Attaching a folder as a workspace |
| Daily notes, templates, wikilinks | Moving a workspace folder |
| Images, added from the photo library, the camera, or Files | |
| Running a block inline, with the host picker and the confirmation | |
| Editing a note's profile | |
| Unlocking locked notes | |
| The trash | |
| Switching workspaces and servers | |

The pages for those features say how each works on a touch screen: Run on every block, the Code Block button, and the control keys above the keyboard in [[Running Code]], adding a picture in [[Images]], the mode chips under the search field in [[Finding Things]], and splits in [[Panes and Tabs]].

Tapping through the tree reuses one tab rather than filling the strip, since a note you tap opens as an italic preview ([[Panes and Tabs]]). A long press on the tab holds Keep Tab Open, which is what makes it stay, and so does typing in the note. It matters more here than on a Mac: there is no ⌘W, so a strip that filled up would take a long press and a menu item per tab to empty.

A block keeps running on the server while the app is in the background, and what it printed is waiting when you come back. A program that needs a whole terminal belongs in a Mac's drawer on the same server.

Unlocking a locked note asks for the passphrase every time. The phone stores none of it, and Face ID does not stand in for it. The relock timer is the server's, so a phone put away for an hour finds its locked notes closed again ([[Note Locking]]).

The manual a phone shows is the connected server's copy, so it describes the version of Ledge that server runs.
