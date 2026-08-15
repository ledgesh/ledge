#!/bin/sh
# Install the run's throwaway key under the forced command, then be an sshd.
set -e

if [ -z "$LEDGE_PUBKEY" ] && [ -z "$LEDGE_PASSWORD" ]; then
  echo "entrypoint: LEDGE_PUBKEY and LEDGE_PASSWORD are both unset; nothing could authenticate" >&2
  exit 2
fi

if [ -n "$LEDGE_PUBKEY" ]; then
  # The authorized_keys line remote.md §4 specifies, verbatim. `restrict` turns
  # off port forwarding, agent forwarding, X11 and pty allocation; `command=`
  # means this key cannot ask for anything else. The probe checks both halves.
  mkdir -p /home/ledge/.ssh
  printf 'restrict,command="ledge-server serve" %s\n' "$LEDGE_PUBKEY" > /home/ledge/.ssh/authorized_keys
  chown -R ledge:ledge /home/ledge/.ssh
  chmod 600 /home/ledge/.ssh/authorized_keys
fi

# The other door (remote.md §4). A password has no `authorized_keys` entry, so
# it carries no forced command and no `restrict` — which is §4a's point made
# literal: what runs is the command the CLIENT asked for, and the protocol comes
# up either way.
#
# One method at a time, chosen by `LEDGE_AUTH`, because the two are not the same
# code path in OpenSSH and a great many real servers answer with
# keyboard-interactive where this one would say password. Naming exactly one
# means a probe that connects has proved which of them it went through.
OPTS=""
if [ -n "$LEDGE_PASSWORD" ]; then
  printf 'ledge:%s\n' "$LEDGE_PASSWORD" | chpasswd
  case "${LEDGE_AUTH:-password}" in
    keyboard-interactive)
      OPTS="-o PasswordAuthentication=no -o KbdInteractiveAuthentication=yes -o UsePAM=yes"
      ;;
    *)
      OPTS="-o PasswordAuthentication=yes -o KbdInteractiveAuthentication=no"
      ;;
  esac
  # Keys off with it. A password container that also took the probe's key would
  # let a broken password door pass by authenticating some other way.
  OPTS="$OPTS -o PubkeyAuthentication=no"
fi

ssh-keygen -A >/dev/null

# Unquoted on purpose: $OPTS is a list of arguments, and there is nothing in it
# from outside this script but a method name matched by the case above.
exec /usr/sbin/sshd -D -e $OPTS
