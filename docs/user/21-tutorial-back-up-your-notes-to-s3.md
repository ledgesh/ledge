# Tutorial: Back Up Your Notes to S3

Put an encrypted copy of your notes, and everything Ledge keeps beside them on your server, into an S3-compatible bucket every hour.

This builds on [[Keep Notes on a Remote Server]], where `ledge-server backup-paths` is described, and on [[Profiles and Secrets]]. It assumes a server set up as in [[Tutorial: Set Up a Ledge Server]]: the package on a Debian or Ubuntu VPS, running as an account named `ledge`, with your own `sudo` account beside it.

The backup tool is restic. It reads the two lists `backup-paths` prints, encrypts on the server before anything leaves it, and keeps versions, so one note from last Tuesday is something you can ask for.

## 1. Make a bucket and a key for it

In your provider's console, create a bucket for the backup and an access key pair that can read and write that bucket and nothing else. Any S3-compatible service works.

Write down four things: the bucket's endpoint, its name, the access key ID, and the secret. The endpoint becomes a restic repository address:

| Service | `RESTIC_REPOSITORY` |
| --- | --- |
| Amazon S3 | `s3:s3.amazonaws.com/BUCKET` |
| Cloudflare R2 | `s3:https://ACCOUNT.r2.cloudflarestorage.com/BUCKET` |
| Backblaze B2 | `s3:https://s3.REGION.backblazeb2.com/BUCKET` |
| Wasabi | `s3:https://s3.REGION.wasabisys.com/BUCKET` |
| MinIO or another self-hosted service | `s3:https://HOST:9000/BUCKET` |

## 2. Install restic on the server

On the VPS, as your own account:

```sh norun
sudo apt-get install -y restic
```

## 3. Put the credentials in a profile

In Ledge, on the server, press ⌘N and make a note called Backups with this frontmatter:

```
---
profile: backup
---
```

Run "Edit Note Profile…" from the command palette and add four rows:

| Key | Value |
| --- | --- |
| `RESTIC_REPOSITORY` | The address from step 1 |
| `RESTIC_PASSWORD` | A long random string with no spaces |
| `AWS_ACCESS_KEY_ID` | The access key ID |
| `AWS_SECRET_ACCESS_KEY` | The secret |

The password encrypts the backup. Make one with `openssl rand -base64 32`, and keep a copy somewhere that is not this server: a restore starts on a machine with nothing on it, and a password stored only inside the backup is a backup you cannot open.

Saving writes `/home/ledge/.config/ledge/profiles/backup.env` on the server, readable by that account alone. Every block in this note now runs with those four variables set, and the timer in step 5 reads the same file.

## 4. Create the repository and take the first backup

Add three blocks to the Backups note:

````
```sh
restic init
```

```sh
restic backup --files-from <(ledge-server backup-paths) --exclude-file <(ledge-server backup-paths --exclude)
```

```sh
restic snapshots
```
````

Run the first once. It creates the repository in the bucket and prints its ID.

Run the second. `backup-paths` lists the app home, every workspace folder attached from elsewhere on the machine, and the profiles directory, and the `--exclude` list drops the daemon's socket and pidfile, the logs, and the copy of this manual. restic reads both, uploads, and prints how much went.

Run the third. One snapshot, with a time and a hostname. The note is now a button for a backup of the machine it lives on, run before an upgrade or whenever you want to know the last one worked.

## 5. Run it every hour

On the VPS, as your own account, create `/etc/systemd/system/ledge-backup.service`:

```ini
[Unit]
Description=Ledge backup

[Service]
Type=oneshot
User=ledge
EnvironmentFile=/home/ledge/.config/ledge/profiles/backup.env
ExecStart=/bin/bash -c 'restic backup --files-from <(ledge-server backup-paths) --exclude-file <(ledge-server backup-paths --exclude)'
ExecStart=restic forget --keep-hourly 24 --keep-daily 30 --keep-weekly 12 --keep-monthly 24 --prune
```

`User=ledge` runs it as the server's account, which is the account whose registry `backup-paths` reads. `ExecStart` names `/bin/bash` because systemd runs no shell of its own and the two `<(...)` substitutions need one. The second `ExecStart` thins old snapshots to a day of hourlies, a month of dailies, a quarter of weeklies, and two years of monthlies.

Then `/etc/systemd/system/ledge-backup.timer`:

```ini
[Unit]
Description=Ledge backup, hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` runs a backup that was missed while the machine was off. Start it:

```sh norun
sudo systemctl enable --now ledge-backup.timer
sudo systemctl start ledge-backup.service
sudo journalctl -u ledge-backup --no-pager | tail
```

The second line runs one backup now instead of waiting for the hour, and the third shows what it printed. `systemctl list-timers ledge-backup.timer` says when the next one is due.

## 6. Get a note back

Add one more block to the Backups note:

````
```sh
restic restore latest --target /tmp/restored --include '*/shipping-notes.md'
```
````

It puts that one file, from the newest snapshot, under `/tmp/restored` with its original path beneath. `restic snapshots` lists older ones, and any snapshot's ID goes where `latest` is.

Do this once now, with a note you have, before you need it.

## 7. Restore everything onto a new server

On a fresh machine set up through step 4 of [[Tutorial: Set Up a Ledge Server]], with restic installed and the four variables in `/home/ledge/.config/ledge/profiles/backup.env` again by hand:

```sh norun
restic restore latest --target /
```

The paths inside the backup are absolute, so restoring to `/` puts the app home, the attached folders, and the profiles back where they were. Then connect from Ledge. Your workspaces, images, trash, profiles, and vault are all there, and locked notes open with the passphrase they had ([[Note Locking]]).

## Where to go next

- **Check the repository now and then.** A `restic check` block in the Backups note reads the bucket and reports anything missing or corrupt.
- **Keep the provider's snapshots too.** A snapshot restores the machine, and this backup restores your notes to any machine. [[Keep Notes on a Remote Server]] compares the two.
- **Back up a laptop the same way.** `ledge-server backup-paths` is not on a Mac that runs the app, but a Mac's notes are folders ([[Tutorial: Keep Notes Synced]]).
