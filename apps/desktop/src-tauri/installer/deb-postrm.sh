#!/bin/sh
# Runs after the Lobster Browser package is removed.
#
# WHAT THIS DELETES, AND WHAT IT DELIBERATELY DOES NOT.
#
# The browser engine is downloaded on first run into a per-user cache rather than shipped in the
# package, so dpkg has no record of it and `apt remove` leaves ~800 MB behind on every account that
# ever launched the app. That is a cache: it is re-downloadable, identical for every user, and
# contains nothing the user made. Removing it is the whole reason this script exists.
#
# PROFILES ARE NOT TOUCHED. They are the user's work - cookies, sessions, saved logins, the
# fingerprints they configured - and an uninstall is not consent to destroy them. `apt remove` is
# also how an upgrade is performed on some setups, so deleting them here would silently wipe
# everything on a routine update. `purge` is the verb Debian reserves for "and the data too", and it
# is handled separately below.
set -e

ENGINE_REL=".local/share/lobster/lobium"
DATA_REL=".local/share/com.lobster.browser"

remove_engine_for() {
  home="$1"
  [ -n "$home" ] || return 0
  [ -d "$home/$ENGINE_REL" ] || return 0
  rm -rf "$home/$ENGINE_REL"
  # Only if now empty - another Lobster directory may live beside it.
  rmdir "$home/.local/share/lobster" 2>/dev/null || true
}

# Every real login account, not just the invoking one: the engine is per-user, and a machine with
# three users has three copies. Bounded to normal UID ranges so system accounts are skipped.
each_home() {
  getent passwd 2>/dev/null | awk -F: '($3 >= 1000 && $3 < 65534) { print $6 }'
  echo "/root"
}

case "$1" in
  remove|upgrade|deconfigure)
    each_home | while IFS= read -r home; do remove_engine_for "$home"; done
    ;;
  purge)
    each_home | while IFS= read -r home; do
      remove_engine_for "$home"
      # purge is the explicit "and the data too" verb, so profiles go here and ONLY here.
      [ -n "$home" ] && [ -d "$home/$DATA_REL" ] && rm -rf "$home/$DATA_REL"
    done
    ;;
esac

exit 0
