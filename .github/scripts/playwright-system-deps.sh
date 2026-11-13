#!/usr/bin/env bash
# Installs the OS packages Playwright's Chromium and Firefox want, within a
# bound, and says what to do when the package mirrors cannot be reached.
#
# `npx playwright install-deps` is an `apt-get update` plus an `apt-get install`
# of about forty packages (fonts and media libraries the runner image lacks).
# It normally takes about 20 s. On 2026-11-11 the GitHub runners could not
# resolve the Ubuntu mirrors for hours: apt then waited some 40 s per package,
# one package at a time, and the job died at its 30-minute limit three times in
# a row without a single test having started.
#
# So each attempt has a time limit, and when every attempt fails the job goes
# on only if both browsers start with what the runner image already has. A
# browser that does not start fails the job here, in minutes, with the reason.
#
# Tunables (the tests shorten them): PW_DEPS_ATTEMPTS, PW_DEPS_ATTEMPT_SECONDS,
# PW_DEPS_PAUSE_SECONDS.
set -uo pipefail

ATTEMPTS="${PW_DEPS_ATTEMPTS:-2}"
ATTEMPT_SECONDS="${PW_DEPS_ATTEMPT_SECONDS:-150}"
PAUSE_SECONDS="${PW_DEPS_PAUSE_SECONDS:-20}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  echo "Installing the Playwright system dependencies (attempt $attempt of $ATTEMPTS, limit ${ATTEMPT_SECONDS}s)..."
  # The limit runs as root on purpose. Playwright runs apt through sudo, and a
  # signal sent by the runner's own user does not reach a root process, so a
  # `timeout` in front of a plain `npx` would expire and leave apt running.
  # `timeout` signals its whole process group, apt included.
  if sudo env "PATH=$PATH" timeout --kill-after=15 "$ATTEMPT_SECONDS" npx playwright install-deps chromium firefox; then
    echo "System dependencies installed."
    exit 0
  fi
  echo "::warning::playwright install-deps: attempt $attempt of $ATTEMPTS failed or passed its ${ATTEMPT_SECONDS}s limit"
  # An apt stopped midway can leave a package unpacked but not configured
  sudo dpkg --configure -a || echo "::warning::dpkg --configure -a failed after the interrupted attempt"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$PAUSE_SECONDS"
  fi
  attempt=$((attempt + 1))
done

echo "::warning::The package mirrors could not be used. Checking whether Chromium and Firefox start with what the runner image already has."
if node "$HERE/playwright-launch-probe.mjs"; then
  echo "::warning::Both browsers start. Continuing WITHOUT the extra system packages (some fonts and media libraries may be missing): a test that fails on rendering in this run is suspect."
  exit 0
fi

echo "::error::The Playwright system dependencies could not be installed and a browser does not start without them. The package mirrors were unreachable from this runner; run the job again later."
exit 1
