#!/usr/bin/env bash
set -u
Xvfb :79 -screen 0 1200x800x24 >/tmp/xvfb79.log 2>&1 & XPID=$!
sleep 2
UDD=$(mktemp -d)
DISPLAY=:79 ~/.local/share/lobster/lobium/chrome \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --no-sandbox --no-first-run --no-default-browser-check \
  --user-data-dir="$UDD" --remote-debugging-port=9779 about:blank >/tmp/chrome79.log 2>&1 & CPID=$!
sleep 6
echo "done-launch"
