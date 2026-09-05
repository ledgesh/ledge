# Tutorial: Set Up a Ledge Server

Turn a fresh Linux VPS into a Ledge server: an account for Ledge, the server package, a key that can do nothing but Ledge, and an sshd that ignores everyone else.

This builds on [[Keep Notes on a Remote Server]], which is the reference for every step here. The commands assume Debian or Ubuntu. Any Linux with glibc 2.29 or newer works, so substitute your package manager on anything else.

Two accounts appear throughout. `you@vps` is the account your provider gave you, which can `sudo`. `ledge@vps` is the account you create in step 1, which cannot.

## 1. Create an account for Ledge

On the VPS, as your own account:

```sh norun
sudo adduser --disabled-password --gecos "" ledge
```

The account has no password and no `sudo`. Everything Ledge does on this machine runs as this account: the server, the shells, and every block in every note. A key for it that is ever stolen cannot become root.

If your notes need `sudo`, that is a decision for later, made with `visudo` and as narrow as you can make it.

`adduser` gives the account bash as its login shell, which is one of the two shells Ledge runs blocks in.

## 2. Make a key on your Mac

In a terminal on your Mac:

```sh norun
ssh-keygen -t ed25519 -f ~/.ssh/ledge -C ledge@laptop
cat ~/.ssh/ledge.pub
```

Leave the key's passphrase empty, or use one your ssh agent already holds. Ledge's ssh runs with no terminal attached, so a passphrase it would have to type at a prompt never gets typed. This is about the key file only: signing in with the account's password is a choice on the form, and [[Keep Notes on a Remote Server]] covers it. This tutorial uses a key so that step 8 can turn passwords off.

Copy the printed line, then put it on the VPS as the new account's only key. As your own account there, with the line pasted in place of the placeholder:

```sh norun
sudo install -d -m 700 -o ledge -g ledge /home/ledge/.ssh
echo 'ssh-ed25519 AAAA... ledge@laptop' | sudo tee /home/ledge/.ssh/authorized_keys
sudo chown ledge:ledge /home/ledge/.ssh/authorized_keys
sudo chmod 600 /home/ledge/.ssh/authorized_keys
```

The line goes in unrestricted for now. Step 7 restricts it, once you know the server works.

## 3. Install the server

Still on the VPS, as your own account:

```sh norun
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
sudo BUN_INSTALL=/usr/local bun add -g ledge-server
```

Both commands carry `BUN_INSTALL=/usr/local`. Bun puts global commands beside itself, and `/usr/local/bin` is on the short PATH an incoming ssh gets. Without the variable, the server lands in a home directory that ssh never searches.

Nothing else needs installing and no service needs starting. Ledge starts the server over ssh when it connects, and the server exits a minute after the last device leaves, unless a block is still running.

## 4. Check that ssh can find it

From your Mac, as the new account, with the new key:

```sh norun
ssh -i ~/.ssh/ledge ledge@vps 'command -v ledge-server; command -v bun'
```

Two paths printed means the machine is ready. Keep the first one; step 7 needs it.

Nothing printed means Bun was already installed for one user before you started, and its commands are in a directory ssh does not search. [[Keep Notes on a Remote Server]] shows the two symlinks that fix it.

## 5. Add the server in Ledge

Run "Notes On…" from the command palette, choose Add, and fill in the form:

| Field | Value |
| --- | --- |
| Name | Whatever you want the connection bar to say |
| SSH destination | `ledge@vps` |
| Port | Blank |
| Sign in with | A key |
| Key | `~/.ssh/ledge` |

Ledge fetches the machine's host key and shows its fingerprint. Get the same fingerprint from the machine itself, in your terminal on the VPS:

```sh norun
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Choose "It Matches, Add" when the two agree. Ledge pins the key and refuses any future connection from that address that presents a different one.

## 6. Try it

The connection bar now names the server. Press ⌘N, and the note you create is a file on the VPS. Give it one block:

````
```sh
hostname; whoami
```
````

⌘↩ prints the VPS's hostname and `ledge`. The block ran on the server, as the account you made, and the note never left it.

## 7. Restrict the key to Ledge

Edit `/home/ledge/.ssh/authorized_keys` on the VPS and put a prefix in front of the key, using the path step 4 printed:

```
restrict,command="/usr/local/bin/ledge-server serve" ssh-ed25519 AAAA... ledge@laptop
```

That key can now speak Ledge's protocol and nothing else: no shell, no port forwarding, no file copying. sshd runs the named command whatever the client asks for, so the terminal check in step 4 stops working for this key. That is expected. Your own account is the one for terminals.

The connection you already have keeps working. Ledge's next connection, at the next launch or after a drop, uses the restricted line.

## 8. Turn off passwords in sshd

A Ledge server runs whatever its notes say, so sshd should answer keys and nothing else. Create `/etc/ssh/sshd_config.d/10-ledge.conf`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
```

The `10-` matters. sshd keeps the first value it reads for a setting, and it reads this directory in name order. Cloud images ship a `50-cloud-init.conf` that turns passwords on, and a file named after it would lose.

Your own account has to sign in with a key from now on. The provider usually installed one when it created the VPS, and this line from your Mac says whether it did:

```sh norun
ssh -o PasswordAuthentication=no you@vps true
```

If it asks for a password, put a key on that account first, with `ssh-copy-id`.

Then check the configuration and reload, keeping your current terminal open until a second one has logged in:

```sh norun
sudo sshd -t && sudo systemctl reload ssh
```

## 9. Ban repeated guesses with fail2ban

Keys-only sshd refuses every guess, but a box on the public internet still receives thousands of them a day, and each one costs a log line and a connection slot. fail2ban blocks an address after a few failures.

```sh norun
sudo apt-get install -y fail2ban
```

Create `/etc/fail2ban/jail.local`:

```ini
[sshd]
enabled = true
backend = systemd
maxretry = 5
bantime = 1h
```

`backend = systemd` reads sshd's log from the journal. Debian 12, Ubuntu 24.04, and anything newer ship without a text `auth.log`, and fail2ban without this line fails to start on them.

```sh norun
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

The second command prints the jail's counts. Ledge never trips it: it connects with a key sshd accepts, and reconnects the same way.

## 10. Close every other port

Only sshd needs to be reachable. Allow it, then turn the firewall on:

```sh norun
sudo apt-get install -y ufw
sudo ufw allow 22/tcp
sudo ufw enable
sudo ufw status
```

Ubuntu has `ufw` already, and the install line does nothing there.

If the VPS is on a tailnet or VPN, allow ssh from that interface alone and drop the public rule:

```sh norun
sudo ufw allow in on tailscale0 to any port 22
sudo ufw delete allow 22/tcp
```

Then use the tailnet address as the SSH destination in Ledge. A server nobody else can reach has nothing for fail2ban to do, and the previous step does no harm.

## 11. Keep it patched

Security updates for the operating system should install themselves:

```sh norun
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Answer Yes. Ubuntu ships with this on, and the two commands confirm it.

The server itself is a package, and updating it is the install line again:

```sh norun
sudo BUN_INSTALL=/usr/local bun add -g ledge-server@latest
```

A connection between an app and a server that cannot understand each other is refused with a sentence naming which end to update, so a version that falls behind is reported rather than guessed at.

## Where to go next

- **Back it up.** The notes now live on one disk that belongs to one provider. [[Tutorial: Back Up Your Notes to S3]] puts an encrypted copy in a bucket every hour.
- **Add your phone.** Its pairing screen hands you a line for this same `authorized_keys`, already restricted ([[Ledge on Your Phone]]).
- **Install what your notes run.** `git`, a language, a cloud CLI: whatever a block on this machine needs, installed as your own account with `apt-get`.
- **Reach other machines from it.** A note on the VPS can carry `host: prod`, and the VPS makes that ssh connection with a key in `/home/ledge/.ssh` ([[Run Code on Remote Hosts]]).
