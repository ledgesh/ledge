# Tutorial: Back Up Your Notes to S3

Put an encrypted copy of your notes, and everything Ledge keeps beside them, into an S3-compatible bucket, every hour, from the machine that holds them.

This works the same on a computer that runs the app and on a server set up as in [[Tutorial: Set Up a Ledge Server]]. Every command below runs on that machine, as the account Ledge runs as, and needs the `ledge` command on its PATH: a server has it from the install, and the app's computer gets it from "Install Shell Command (ledge)" in the command palette ([[The ledge CLI]]).

The backup tool is restic, and `ledge backup` does everything around it: it fetches restic, keeps the credentials, creates the repository, computes what to back up, and keeps the schedule. restic encrypts on the machine before anything leaves it, and keeps versions, so one note from last Tuesday is something you can ask for.

## 1. Make a bucket and a key for it

In your provider's console, create a bucket for the backup and an access key pair that can read and write that bucket and nothing else. Any S3-compatible service works.

Write down four things: the bucket's endpoint, its name, the access key ID, and the secret.

| Service | Endpoint |
| --- | --- |
| Amazon S3 | `s3.amazonaws.com` |
| Cloudflare R2 | `https://ACCOUNT.r2.cloudflarestorage.com` |
| Backblaze B2 | `https://s3.REGION.backblazeb2.com` |
| Wasabi | `https://s3.REGION.wasabisys.com` |
| MinIO or another self-hosted service | `https://HOST:9000` |

## 2. Set it up

On the machine, in any shell:

```sh norun
ledge backup setup
```

It asks for the endpoint, the bucket, the access key ID, and the secret. Then it does five things:

| Step | What happens |
| --- | --- |
| restic | Uses a restic already on the PATH, or downloads the release Ledge pins into `~/.ledge/.server`, checked against its published SHA-256. |
| Credentials | Writes the four values and a generated restic password to the `backup` profile, `~/.config/ledge/profiles/backup.env`, readable by this account alone ([[Profiles and Secrets]]). |
| Repository | Creates the restic repository in the bucket. |
| First backup | Backs up everything `ledge backup paths` lists: the app home, every folder attached from elsewhere on the machine, and the profiles. |
| Password | Prints the password, the one thing `setup` writes to stdout. |

The password is what encrypts the backup, and it is the only key. Nothing can be restored without it. Copy it somewhere that is not this machine, such as a password manager.

## 3. Leave it running

Backups run every hour while this machine's Ledge server is up, and once more before it exits.

On a computer that runs the app, the server is up while the app is open and for a minute after it closes. On a VPS, it is up while a device is connected and for a minute after. Quitting the app or closing your laptop's connection is followed by a backup of whatever changed. A machine you open Ledge on after a week away backs up as soon as the server starts.

Nothing else needs installing: no timer, no unit file, no line in a crontab. One line is worth adding on a server where notes are written while no device is connected, by the `ledge` command or by an agent, since those do not start the server:

```sh norun
0 * * * * $HOME/.ledge/.server/bin/ledge backup now
```

`ledge backup now` takes a backup at any time and is safe to run beside the schedule.

Old snapshots are thinned after each backup, and what survives is fixed:

| Kept | For |
| --- | --- |
| The ten newest snapshots | however close together they were taken |
| One an hour | a day |
| One a day | a month |
| One a week | a quarter |
| One a month | two years |

Only the snapshots Ledge took are thinned, so a bucket shared with another tool's backups keeps those whatever this policy says.

## 4. Check on it

```sh norun
ledge backup status
```

It prints the repository, the restic in use, when the last backup ran and whether it succeeded, when the next is due, and any attached folder the last run could not find:

```
repository   s3:https://acct.r2.cloudflarestorage.com/ledge-notes
restic       0.19.1 at /home/ledge/.ledge/.server/backup/restic-0.19.1
last backup  12 min ago, ok (snapshot 2d55744c)
next backup  in 48 min (the server is running)
```

A folder on an unmounted volume is skipped rather than failing the run, and shows here as a `SKIPPED` line until it is back. `ledge backup snapshots` lists what is in the repository, newest first.

## 5. Get a note back

```sh norun
ledge backup restore '*/shipping-notes.md'
```

It puts that one file, from the newest snapshot, into a fresh folder under your home, with its original path beneath, and prints the folder. `--snapshot ID` names an older snapshot from the `snapshots` list, and `--to DIR` names the folder.

Do this once now, with a note you have, before you need it.

## 6. Restore everything onto a new machine

On a fresh machine with Ledge installed, the app on a desktop or the server on a VPS, and the four values and the password at hand:

```sh norun
ledge backup setup --existing
```

It asks the same questions plus the password, opens the repository instead of creating one, writes the profile, and prints the newest snapshot in it. It takes no backup, since there is nothing on this machine to back up yet. Then, with the app quit or the daemon stopped:

```sh norun
ledge backup restore --in-place
```

The paths inside the backup are absolute, so this puts the app home, the attached folders, and the profiles back where they were. `--snapshot ID` restores an older one than the newest. Then open Ledge, or connect to the server. Your workspaces, images, trash, profiles, and vault are all there, and locked notes open with the passphrase they had ([[Note Locking]]). Backups continue on the new machine with the same repository.

## Run restic yourself

`ledge backup restic` runs restic with the backup's repository and credentials, for anything the verbs above do not cover:

```sh norun
ledge backup restic check
```

A note with `profile: backup` in its frontmatter gets the same variables in its shells, so a Backups note can hold restic blocks of its own.

## Where to go next

- **Check the repository now and then.** `ledge backup restic check` reads the bucket and reports anything missing or corrupt.
- **Keep the provider's snapshots too.** A snapshot restores the machine, and this backup restores your notes to any machine. [[Keep Notes on a Remote Server]] compares the two.
- **Use a backup tool of your own.** `ledge backup paths` prints what to back up and `ledge backup paths --exclude` what to skip, for any tool that reads a path list.
