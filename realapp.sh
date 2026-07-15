#!/usr/bin/env bash
set -u
Xvfb :82 -screen 0 1400x900x24 >/tmp/xvfb82.log 2>&1 & XPID=$!
sleep 2
export DISPLAY=:82
# run the installed desktop app via its launcher (sources env)
nohup ~/.local/bin/lobster-browser >/tmp/lobapp.log 2>&1 &
APPID=$!
sleep 12
scrot -o /home/ivyhfx/browser/ci/validation/reports/real-app.png 2>/tmp/scrot82.log
# try to open New Profile via xdotool if available, else just shell shot
sleep 1
kill $APPID 2>/dev/null; pkill -f lobster-desktop 2>/dev/null; pkill -f "\.local/share/lobster/lobium/chrome" 2>/dev/null
sleep 1; kill -9 $XPID 2>/dev/null
echo "done"
