#!/usr/bin/env bash
# Installs the given Ubuntu packages with apt, within a bound, for a job that
# cannot go on without them (the Linux release build links against them).
#
# Usage: bash .github/scripts/apt-install.sh <package>...
#
# An unbounded `apt-get update && apt-get install` waits as long as the
# package mirrors make it: on 2026-11-11 the runners could not resolve them for
# hours, apt waited some 40 s per package, one package at a time, and the end
# -to-end job died at its time limit three times before anything had run
# (.github/scripts/playwright-system-deps.sh handles that job). Here there is
# no fallback: without the packages the build fails anyway. So each attempt
# (update plus install) has a time limit, a failed attempt is retried twice
# after a pause, and when every attempt has failed the step fails with the
# reason, in minutes rather than at the job limit.
#
# Tunables (the tests shorten them): APT_ATTEMPTS, APT_ATTEMPT_SECONDS,
# APT_PAUSE_SECONDS.
set -uo pipefail

ATTEMPTS="${APT_ATTEMPTS:-3}"
ATTEMPT_SECONDS="${APT_ATTEMPT_SECONDS:-180}"
PAUSE_SECONDS="${APT_PAUSE_SECONDS:-30}"

if [ "$#" -eq 0 ]; then
  echo "::error::apt-install.sh: no package named"
  exit 2
fi
# Package names only: nothing that apt could read as an option
for pkg in "$@"; do
  if ! [[ $pkg =~ ^[a-z0-9][a-z0-9.+-]*$ ]]; then
    echo "::error::apt-install.sh: '$pkg' is not a package name"
    exit 2
  fi
done

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  echo "Installing $* (attempt $attempt of $ATTEMPTS, limit ${ATTEMPT_SECONDS}s)..."
  # The limit runs as root on purpose: apt runs as root, and a signal sent by
  # the runner's own user does not reach a root process, so a `timeout` in
  # front of `sudo` would expire and leave apt running. `timeout` signals its
  # whole process group, apt included.
  if sudo env DEBIAN_FRONTEND=noninteractive timeout --kill-after=15 "$ATTEMPT_SECONDS" \
    bash -c 'apt-get update && apt-get install -y "$@"' apt-install "$@"; then
    echo "Packages installed."
    exit 0
  fi
  echo "::warning::apt-get: attempt $attempt of $ATTEMPTS failed or passed its ${ATTEMPT_SECONDS}s limit"
  # An apt stopped midway can leave a package unpacked but not configured
  sudo dpkg --configure -a || echo "::warning::dpkg --configure -a failed after the interrupted attempt"
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$PAUSE_SECONDS"
  fi
  attempt=$((attempt + 1))
done

echo "::error::The packages could not be installed in $ATTEMPTS attempts of ${ATTEMPT_SECONDS}s: the package mirrors may be unreachable from this runner. The build needs them, so it stops here; run the job again later."
exit 1
