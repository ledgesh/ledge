# A Ledge server as an image, for the machine that is always on when your
# laptop is not (docs/contributor/remote.md §11).
#
# The image ships NO sshd, and that is the design rather than an omission.
# §3's whole argument for ssh is that Ledge inherits the most-audited daemon on
# the machine instead of writing an authentication system; running a second
# sshd inside a container — its own host keys, its own published port, its own
# authorized_keys to keep — would give that back. So the host's sshd is the one
# that answers, and the forced command §4 describes reaches in:
#
#     restrict,command="docker exec -i ledge ledge-server serve" ssh-ed25519 AAAA...
#
# -i and not -t, for §4's reason: this stdout IS the protocol, and a pty would
# translate newlines inside a length-prefixed stream.
#
# PID 1 is the daemon itself, so `docker exec` runs the cheap half — a pump to
# a socket that is already there, holding the notes and the running shells
# (§1). A container the user started is also why the daemon does not idle out
# here: `ledge-server daemon` without --autostart stays until it is stopped,
# because a supervisor restarting a process every minute for correctly deciding
# nobody was home is not a design anyone would choose.
#
# Build it for the architecture it will run on. There is no fat ELF, so the
# trampolines (`scripts/build-native.ts`) are compiled inside this build rather
# than cross-compiled into it; `docker build --platform` is the knob.

# debian-slim and not alpine, per §11: the PTY layer is bun:ffi over
# posix_spawn and forkpty, and musl has no posix_spawn_file_actions_addchdir_np
# at all.
FROM oven/bun:1-debian AS build

# The one thing the build needs that the runtime must not have: a compiler.
# `pty.ts` falls back to compiling the trampolines in-process, which needs the
# headers, and shipping those to every server so a fallback can run is exactly
# backwards. Compile here; the runtime stage gets the .so and no toolchain.
#
# procps is for `bun test` rather than for the build: this stage is also where
# the suite runs against glibc (`remote.md` §13), and pty.fs.test.ts asks `ps`
# whether a closed shell was collected or left as a zombie.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json tsconfig.json bunfig.toml electrobun.config.ts THIRD-PARTY-NOTICES.md ./
COPY scripts ./scripts
COPY docs/user ./docs/user
COPY src ./src

RUN bun scripts/build-native.ts \
  && bun build src/bun/serve.ts --compile --outfile /out/ledge-server \
  && cp dist-native/libledge_pty.so /out/


FROM debian:trixie-slim

# zsh because that is the default shell in settings.jsonc and a default that
# needs a settings file to work is not a default. openssh-client for `host:`
# frontmatter, where the SERVER makes the outbound connection (§6). Everything
# a user's notes actually run — git, a language, a cloud CLI — is theirs to add
# in a `FROM ledge-server` of their own; guessing at that list here would be a
# maintenance claim on somebody else's toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client zsh \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/zsh --uid 1000 ledge \
  && mkdir -p /data && chown ledge:ledge /data

# Beside the executable, which is where pty.ts looks third: inside a compiled
# binary `import.meta.dir` names a path in the embedded filesystem, where
# nothing was ever copied.
COPY --from=build /out/ledge-server /usr/local/bin/ledge-server
COPY --from=build /out/libledge_pty.so /usr/local/bin/libledge_pty.so

# One directory to mount and one to back up: notes, workspace registry, vault,
# layout, and logs all live under the app home (remote.md §5).
ENV LEDGE_NOTES_ROOT=/data
VOLUME /data

USER ledge
WORKDIR /data
CMD ["ledge-server", "daemon"]
