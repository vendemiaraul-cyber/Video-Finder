#!/bin/sh
# Start SearXNG inside the container, then the MeoDeo gate on the public port.
set -eu
export GRANIAN_HOST=127.0.0.1 GRANIAN_PORT=8888
/usr/local/searxng/entrypoint.sh &
exec /usr/local/searxng/.venv/bin/python /usr/local/searxng/gate.py
