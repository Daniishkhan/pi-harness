#!/bin/sh
set -eu

case "${PI_HARNESS_CELL_UID-}:${PI_HARNESS_CELL_GID-}" in
  "":*|*:""|0:*|*:0|*[!0-9:]* )
    echo "pi-cell-bootstrap: invalid keep-id target" >&2
    exit 1
    ;;
esac

# Block well-known cloud instance-metadata endpoints inside this cell's own
# network namespace. These commands run before any request, workspace file,
# extension, or model-controlled argument is read.
/usr/sbin/ip -4 route replace prohibit 169.254.169.254/32
/usr/sbin/ip -4 route replace prohibit 100.100.100.200/32
# Defense in depth for Podman's conventional pasta host-loopback mapping;
# create also disables that mapping explicitly.
/usr/sbin/ip -4 route replace prohibit 169.254.1.2/32
/usr/sbin/ip -6 route replace prohibit fd20:ce::254/128
/usr/sbin/ip -6 route replace prohibit fd00:ec2::254/128

# Become an unprivileged PID 1 before Pi starts. tini forwards signals and
# reaps orphaned descendants; its own capability bounding set is empty.
exec /usr/bin/setpriv \
  --reuid="$PI_HARNESS_CELL_UID" \
  --regid="$PI_HARNESS_CELL_GID" \
  --clear-groups \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  /usr/bin/tini -g -- \
  /usr/local/bin/node \
  /opt/pi-harness/container/entrypoint.mjs \
  /run/pi-cell-launch/request.json
