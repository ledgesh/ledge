#!/bin/sh
# Installs ledge-server @VERSION@, the server Ledge's apps connect to over ssh,
# into ~/.ledge-server for the account that runs it:
#   curl -fsSL https://ledge.sh/server.sh | sh
# Downloads the npm package and a private Bun from the npm registry, checked
# against the checksums below. Built from release/server.sh (remote.md §11).

set -eu

version='@VERSION@'
registry="${LEDGE_SERVER_REGISTRY:-@REGISTRY@}"
server_sum='@SERVER_SUM@'
bun_version='@BUN_VERSION@'
bun_package_darwin_arm64='@BUN_PACKAGE_DARWIN_ARM64@'
bun_sum_darwin_arm64='@BUN_SUM_DARWIN_ARM64@'
bun_package_darwin_x64='@BUN_PACKAGE_DARWIN_X64@'
bun_sum_darwin_x64='@BUN_SUM_DARWIN_X64@'
bun_package_linux_arm64='@BUN_PACKAGE_LINUX_ARM64@'
bun_sum_linux_arm64='@BUN_SUM_LINUX_ARM64@'
bun_package_linux_x64='@BUN_PACKAGE_LINUX_X64@'
bun_sum_linux_x64='@BUN_SUM_LINUX_X64@'

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
  say ""
  say "LEDGE_SERVER_REGISTRY=<url> downloads from an npm mirror instead of $registry."
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

# Downloads a package tarball into $tmp/<name>.tgz, checks it against its
# checksum and unpacks it into $tmp/<name>, where npm puts it under package/.
get() {
  url=$1
  file=${url##*/}
  fetch "$url" "$tmp/$2.tgz" || refuse "could not download $url"
  got=$(sha256_of "$tmp/$2.tgz")
  if [ "$got" = none ]; then
    refuse "checking the download needs sha256sum or shasum, and this machine has neither."
  fi
  if [ "$got" != "$3" ]; then
    refuse "$file does not match its checksum, so nothing was installed. Expected $3, got $got."
  fi
  mkdir "$tmp/$2"
  tar -xzf "$tmp/$2.tgz" -C "$tmp/$2" || refuse "could not unpack $file"
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
  eval "bun_package=\$bun_package_${os}_${arch} bun_sum=\$bun_sum_${os}_${arch}"
  case "$os" in
    darwin) native="lib/native/$os-$arch/libledge_pty.dylib" ;;
    *) native="lib/native/$os-$arch/libledge_pty.so" ;;
  esac

  root="$HOME/.ledge-server"
  server_url="$registry/ledge-server/-/ledge-server-$version.tgz"
  bun_url="$registry/$bun_package/-/${bun_package##*/}-$bun_version.tgz"
  target="$root/versions/$version"
  launcher="$root/bin/ledge-server"
  previous=$(sed -n 's/^# ledge-server version //p' "$launcher" 2>/dev/null || true)

  if [ "$dry_run" -eq 1 ]; then
    say "Would install ledge-server $version for $os-$arch"
    say "  from $server_url"
    say "  with Bun $bun_version from $bun_url"
    say "  into $target"
    exit 0
  fi

  mkdir -p "$root/versions" "$root/bin"
  if usable "$target"; then
    say "ledge-server $version is already in $target."
  else
    say "Downloading ledge-server $version and Bun $bun_version for $os-$arch..."
    tmp=$(mktemp -d "$root/.download.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    # The server first: it is small, and it is what says whether this release
    # was built for this machine at all.
    get "$server_url" server "$server_sum"
    [ -f "$tmp/server/package/$native" ] || refuse "ledge-server $version has no build for $os-$arch."
    get "$bun_url" bun "$bun_sum"
    mv "$tmp/bun/package/bin/bun" "$tmp/server/package/bun"
    chmod 755 "$tmp/server/package/bun"
    if ! said=$("$tmp/server/package/bun" --version 2>&1); then
      refuse "Bun $bun_version does not run on this machine: $said"
    fi
    usable "$tmp/server/package" || refuse "ledge-server-$version.tgz is missing files, so nothing was installed."
    rm -rf "$target"
    mv "$tmp/server/package" "$target"
  fi

  # Written beside the old launcher and renamed over it, so a connection
  # arriving mid-install runs one version or the other. `ledge` is the same
  # launcher with the cli verb in front of the caller's arguments.
  launcher_text() {
    printf '#!/bin/sh\n'
    printf '# Written by https://ledge.sh/server.sh. Runs ledge-server on the Bun installed beside it.\n'
    printf '# ledge-server version %s\n' "$version"
    printf 'exec %s %s%s "$@"\n' "$(quote "$target/bun")" "$(quote "$target/bin/ledge-server.js")" "$1"
  }
  launcher_text "" >"$launcher.tmp"
  chmod 755 "$launcher.tmp"
  mv -f "$launcher.tmp" "$launcher"
  launcher_text " cli" >"$root/bin/ledge.tmp"
  chmod 755 "$root/bin/ledge.tmp"
  mv -f "$root/bin/ledge.tmp" "$root/bin/ledge"

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
    say "New terminals find it as ledge-server, and its notes as ledge (a PATH line was added to $path_added)."
  fi
  say ""
  say "To pair Ledge on a phone with this machine, run:"
  say ""
  say "  ~/.ledge-server/bin/ledge-server pair"
}

# Everything runs from here, so a download cut short runs nothing.
main "$@"
