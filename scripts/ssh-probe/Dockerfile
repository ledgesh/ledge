# The server behind a real sshd, for `scripts/probe-ssh.ts`.
#
# Not a deployment. The shipped image (`../../Dockerfile`) has no sshd on
# purpose, because the host's is the one that should answer; this one adds one
# so that the ssh hop itself — the forced command, the host-key pin, the argv
# `bun/connections.ts` builds — can be exercised without a second machine.
# docs/contributor/testing.md §6 describes this container; this is that
# container.
#
# It is also the shape of the OTHER supported deployment, the one with no
# Docker in it: a binary on a VPS, reached by ssh, with no daemon running until
# the first connection asks for one. So `serve` autostarts the daemon here,
# where the shipped image has it as PID 1 already.
ARG BASE=ledge-server:probe
FROM ${BASE}

# iptables alongside the sshd, for the one failure a container on loopback
# cannot otherwise supply: a wire that stops carrying bytes without closing.
# Killing the server proves a different thing — the process is gone and the
# pipes close, so the client is TOLD. A rule that drops port 22 tells it
# nothing, and leaves the daemon and the shells running on the far side, which
# is what losing a network actually looks like. The probe adds NET_ADMIN and
# takes it away again; nothing in the shipped image has either.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server iptables \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /run/sshd /home/ledge/.ssh \
  && chown ledge:ledge /home/ledge/.ssh \
  && chmod 700 /home/ledge/.ssh

# The public key arrives at RUN time rather than being baked in, so the probe
# can mint a throwaway pair per run and nothing long-lived is ever in a layer.
# Written by root and handed to ledge, because a bind-mounted authorized_keys
# has the mounter's ownership and sshd's StrictModes correctly refuses it —
# and turning StrictModes off to make a test pass would be testing a server
# nobody runs.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
