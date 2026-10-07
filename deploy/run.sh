#!/bin/zsh
# Wait until the Mac has been up for 15 minutes (only matters right after boot),
# then run the bot. launchd restarts this script whenever it exits.
cd "$(dirname "$0")/.."
BOOT=$(sysctl -n kern.boottime | sed -E 's/.*sec = ([0-9]+).*/\1/')
UP=$(( $(date +%s) - BOOT ))
WAIT=$(( 900 - UP ))
(( WAIT > 0 )) && sleep $WAIT
exec .venv/bin/python -m bot.main
