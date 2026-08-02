#!/bin/sh
# Install the run's throwaway key under the forced command, then be an sshd.
set -e

if [ -z "$LEDGE_PUBKEY" ]; then
  echo "entrypoint: LEDGE_PUBKEY is unset; nothing could authenticate" >&2
  exit 2
fi

# The authorized_keys line remote.md §4 specifies, verbatim. `restrict` turns
# off port forwarding, agent forwarding, X11 and pty allocation; `command=`
# means this key cannot ask for anything else. The probe checks both halves.
mkdir -p /home/ledge/.ssh
printf 'restrict,command="ledge-server serve" %s\n' "$LEDGE_PUBKEY" > /home/ledge/.ssh/authorized_keys
chown -R ledge:ledge /home/ledge/.ssh
chmod 600 /home/ledge/.ssh/authorized_keys

ssh-keygen -A >/dev/null

exec /usr/sbin/sshd -D -e
