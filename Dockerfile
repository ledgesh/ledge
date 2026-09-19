# The Linux build stages the npm package needs (`native-lib`, remote.md §11)
# and, in the last stage, the container the probes use (testing.md §6):
# `probe:ssh` adds an sshd to it, and the glibc run of the suite happens
# inside `--target build`. The image was a deployment once, and remote.md §11
# says why it left the manual. The rest of this header describes the fixture.
#
# The image ships no sshd. remote.md §3's argument for ssh is that Ledge
# inherits the most-audited daemon on the machine instead of writing an
# authentication system, and a second sshd inside a container would give that
# back: its own host keys, its own published port, its own authorized_keys to
# keep.
#
# So the host's sshd is the one that answers, and the forced command
# remote.md §4 describes reaches in:
#
#     restrict,command="docker exec -i ledge ledge serve" ssh-ed25519 AAAA...
#
# -i and not -t, for remote.md §4's reason: this stdout carries the protocol,
# and a pty would translate newlines inside a length-prefixed stream.
#
# PID 1 is the daemon itself, so `docker exec` runs the cheap half: a pump to a
# socket that is already there, holding the notes and the running shells
# (remote.md §1).
#
# A container the user started is also why the daemon does not idle out here.
# `ledge daemon` without --autostart stays until it is stopped, because
# a supervisor would otherwise restart it every minute for correctly deciding
# nobody was home.
#
# Build it for the architecture it will run on. There is no fat ELF, so the
# trampolines (`scripts/build-native.ts`) are compiled inside this build rather
# than cross-compiled into it, and `docker build --platform` is the knob.

# debian-slim and not alpine, per remote.md §11: the PTY layer is bun:ffi over
# posix_spawn and forkpty, and musl has no posix_spawn_file_actions_addchdir_np
# at all.
#
# The Bun is the one server.sh installs: BUN_VERSION in
# src/bun/serverRelease.ts, and serverRelease.test.ts holds the two equal. A
# moving tag such as `1-debian` means whatever image this machine pulled last,
# so the probes and the glibc suite could run a Bun no install ships.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-debian AS native

# The one thing the build needs that the runtime must not have: a compiler.
# `pty.ts` falls back to compiling the trampolines in-process, which needs the
# headers, and shipping those to every server so a fallback can run is exactly
# backwards. Compile here; the runtime stage gets the .so and no toolchain.
#
# procps and openssh-client are for `bun test` rather than for the build: this
# stage is also where the suite runs against glibc (remote.md §13).
# pty.fs.test.ts asks `ps` whether a closed shell was collected or left as a
# zombie, and pair.fs.test.ts describes host keys with ssh-keygen.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential procps openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# The server bundles one npm package, uqr, for `ledge pair`
# (architecture.md §8). The install is pinned by the lockfile and skips install
# scripts, since the root package's postinstall sets up the Mac app's
# toolchain. It stays in the build stages: the runtime stage copies the binary.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY tsconfig.json bunfig.toml electrobun.config.ts THIRD-PARTY-NOTICES.md ./
COPY scripts ./scripts
COPY docs/user ./docs/user
COPY src ./src

RUN bun scripts/build-native.ts


# The trampolines on their own, so `scripts/build-npm.ts` can take them without
# the compiled binary it does not want:
#
#     docker build --platform linux/arm64 --target native-lib \
#       --output type=local,dest=dist-npm/lib/native/linux-arm64 .
#
# A published package carries every target at once (src/bun/npmPackage.ts) and
# ELF has no fat binary, so one container per architecture is how the Linux
# slices get built. `scratch` is what keeps the export to the one file: a local
# output writes the whole stage filesystem.
FROM scratch AS native-lib
COPY --from=native /src/dist-native/libledge_pty.so /


FROM native AS build

RUN bun build src/bun/serve.ts --compile --outfile /out/ledge \
  && cp dist-native/libledge_pty.so /out/


FROM debian:trixie-slim

# zsh because the image gets to choose, and `useradd --shell` below is how it
# says so. The seeded default is this account's login shell where Ledge can
# read block output from it (bun/spawnParams.ts), which is zsh or bash and
# nothing else. Debian would otherwise give the account /bin/sh, which is dash,
# which has no hook to end a block with, so this line and that flag are one
# decision and have to move together.
#
# openssh-client is for `host:` frontmatter, where the server makes the
# outbound connection (remote.md §6). Nothing a user's notes actually run is
# here: the fixture proves the transport and the PTY, not a toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client zsh \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/zsh --uid 1000 ledge \
  && mkdir -p /data && chown ledge:ledge /data

# Beside the executable, which is where pty.ts looks third: inside a compiled
# binary `import.meta.dir` names a path in the embedded filesystem, where
# nothing was ever copied.
COPY --from=build /out/ledge /usr/local/bin/ledge
COPY --from=build /out/libledge_pty.so /usr/local/bin/libledge_pty.so

# Two directories hold state. /data is the app home: notes, workspace
# registry, vault, layout, logs (remote.md §5). The account's home is the
# other: profiles live at ~/.config/ledge/profiles, outside the app home
# (architecture.md §6a), and ~/.ssh is what `host:` frontmatter dials out with
# (remote.md §6). `ledge backup paths` prints both, resolved.
ENV LEDGE_NOTES_ROOT=/data
VOLUME /data

USER ledge
WORKDIR /data
CMD ["ledge", "daemon"]
