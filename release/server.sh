#!/bin/sh
# Installs ledge-server @VERSION@, the server Ledge's apps connect to over ssh,
# into ~/.ledge-server for the account that runs it:
#   curl -fsSL https://ledge.sh/server.sh | sh
# The download carries its own Bun and is checked against the checksums below.
# Built from release/server.sh in github.com/ledgesh/ledge (remote.md §11).

set -eu

version='@VERSION@'
download="${LEDGE_SERVER_DOWNLOAD:-@DOWNLOAD@}"
sum_darwin_arm64='@SUM_DARWIN_ARM64@'
sum_darwin_x64='@SUM_DARWIN_X64@'
sum_linux_arm64='@SUM_LINUX_ARM64@'
sum_linux_x64='@SUM_LINUX_X64@'

say() {
  printf '%s\n' "$*"
}

refuse() {
  printf 'ledge-server: %s\n' "$*" >&2
  exit 1
}

usage() {
  say "Installs ledge-server $version into ~/.ledge-server for this account."
  say ""
  say "  curl -fsSL https://ledge.sh/server.sh | sh"
  say "  curl -fsSL https://ledge.sh/server.sh | sh -s -- --dry-run"
  say ""
  say "  --dry-run          say what would be installed, and change nothing"
  say "  --no-modify-path   leave shell startup files alone"
}

# A value in single quotes, for the line of shell the launcher is.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Sets os and arch, or refuses a machine no release runs on.
detect_platform() {
  kernel=$(uname -s)
  machine=$(uname -m)
  case "$kernel" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) refuse "$kernel is not supported. ledge-server runs on macOS and Linux." ;;
  esac
  case "$machine" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) refuse "$machine processors are not supported. ledge-server runs on arm64 and x86_64." ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ]; then
    check_glibc
  fi
}

# The Linux build needs glibc 2.29 or later (remote.md §11). musl has no
# getconf GNU_LIBC_VERSION, which is how Alpine is told apart.
check_glibc() {
  libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
  case "$libc" in
    "glibc "*) ;;
    *) refuse "this Linux does not use glibc, and ledge-server needs it. Alpine and other musl systems cannot run it; Debian, Ubuntu and Fedora can." ;;
  esac
  glibc=${libc#glibc }
  major=${glibc%%.*}
  minor=${glibc#*.}
  minor=${minor%%.*}
  case "$major$minor" in
    '' | *[!0-9]*) return 0 ;;
  esac
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 29 ]; }; then
    refuse "glibc $glibc is too old. ledge-server needs glibc 2.29 or later: Debian 11, Ubuntu 20.04, RHEL 9 or newer."
  fi
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    refuse "downloading needs curl or wget, and this machine has neither."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    echo "none"
  fi
}

# Whether a directory holds a ledge-server whose Bun runs on this machine.
usable() {
  [ -f "$1/bin/ledge-server.js" ] && [ -f "$1/lib/serve.js" ] && "$1/bun" --version >/dev/null 2>&1
}

# Adds ~/.ledge-server/bin to PATH for new terminals. ssh does not need it: the
# apps put that directory on PATH in the command they run (remote.md §4a).
add_to_path() {
  case ":${PATH:-}:" in
    *":$root/bin:"*) return 0 ;;
  esac
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    */fish | */csh | */tcsh) return 0 ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -f "$rc" ] && grep -q '\.ledge-server/bin' "$rc"; then
    return 0
  fi
  printf '\n# ledge-server (https://ledge.sh/server.sh)\nexport PATH="$HOME/.ledge-server/bin:$PATH"\n' >>"$rc"
  path_added="$rc"
}

main() {
  dry_run=0
  modify_path=1
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --no-modify-path) modify_path=0 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) refuse "unknown option $arg. The options are --dry-run and --no-modify-path." ;;
    esac
  done

  if [ "$(id -u)" -eq 0 ]; then
    refuse "run this as the account Ledge signs in to, not as root. The server installs into that account's home directory. For an account named ledge: curl -fsSL https://ledge.sh/server.sh | sudo -iu ledge sh"
  fi
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    refuse "HOME is not set to a directory, and the server installs into it."
  fi

  detect_platform
  eval "sum=\$sum_${os}_${arch}"
  if [ -z "$sum" ]; then
    refuse "ledge-server $version has no build for $os-$arch."
  fi

  root="$HOME/.ledge-server"
  name="ledge-server-$version-$os-$arch"
  target="$root/versions/$version"
  launcher="$root/bin/ledge-server"
  previous=$(sed -n 's/^# ledge-server version //p' "$launcher" 2>/dev/null || true)

  if [ "$dry_run" -eq 1 ]; then
    say "Would install ledge-server $version for $os-$arch"
    say "  from $download/$name.tar.gz"
    say "  into $target"
    exit 0
  fi

  mkdir -p "$root/versions" "$root/bin"
  if usable "$target"; then
    say "ledge-server $version is already in $target."
  else
    say "Downloading ledge-server $version for $os-$arch..."
    tmp=$(mktemp -d "$root/.download.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    fetch "$download/$name.tar.gz" "$tmp/$name.tar.gz" || refuse "could not download $download/$name.tar.gz"
    got=$(sha256_of "$tmp/$name.tar.gz")
    if [ "$got" = none ]; then
      refuse "checking the download needs sha256sum or shasum, and this machine has neither."
    fi
    if [ "$got" != "$sum" ]; then
      refuse "the download does not match its checksum, so nothing was installed. Expected $sum, got $got."
    fi
    tar -xzf "$tmp/$name.tar.gz" -C "$tmp" || refuse "could not unpack $name.tar.gz"
    if ! said=$("$tmp/$name/bun" --version 2>&1); then
      refuse "the Bun inside ledge-server $version does not run on this machine: $said"
    fi
    usable "$tmp/$name" || refuse "$name.tar.gz is missing files, so nothing was installed."
    rm -rf "$target"
    mv "$tmp/$name" "$target"
  fi

  # Written beside the old launcher and renamed over it, so a connection
  # arriving mid-install runs one version or the other.
  {
    printf '#!/bin/sh\n'
    printf '# Written by https://ledge.sh/server.sh. Runs ledge-server with the Bun it came with.\n'
    printf '# ledge-server version %s\n' "$version"
    printf 'exec %s %s "$@"\n' "$(quote "$target/bun")" "$(quote "$target/bin/ledge-server.js")"
  } >"$launcher.tmp"
  chmod 755 "$launcher.tmp"
  mv -f "$launcher.tmp" "$launcher"

  # The previous version stays, since a server started from it may still be
  # running. Anything older goes.
  for dir in "$root"/versions/*; do
    [ -d "$dir" ] || continue
    kept=${dir##*/}
    if [ "$kept" != "$version" ] && [ "$kept" != "$previous" ]; then
      rm -rf "$dir"
    fi
  done

  path_added=""
  if [ "$modify_path" -eq 1 ]; then
    add_to_path
  fi

  say ""
  say "ledge-server $version is installed in $root."
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    say "A ledge-server $previous that is already running goes on serving until it exits on its own, a minute or more after the last app disconnects. The next connection after that starts $version."
  fi
  case "${SHELL:-}" in
    */csh | */tcsh) say "Warning: this account's login shell is ${SHELL##*/}, which cannot start ledge-server over ssh. Change it with: chsh -s /bin/bash" ;;
  esac
  if [ "$os" = darwin ]; then
    case "$(launchctl print-disabled system 2>/dev/null | grep '"com.openssh.sshd"' || true)" in
      *"=> disabled"* | *"=> true"*) say "Warning: Remote Login is off, so Ledge cannot reach this Mac. Turn it on in System Settings > General > Sharing." ;;
    esac
  elif [ ! -x /usr/sbin/sshd ] && [ ! -x /usr/bin/sshd ]; then
    say "Warning: no ssh server was found in /usr/sbin or /usr/bin, and Ledge connects over ssh. Install openssh-server."
  fi
  if [ -n "$path_added" ]; then
    say "New terminals find it as ledge-server (a PATH line was added to $path_added)."
  fi
  say ""
  say "To pair Ledge on a phone with this machine, run:"
  say ""
  say "  ~/.ledge-server/bin/ledge-server pair"
}

# Everything runs from here, so a download cut short runs nothing.
main "$@"
