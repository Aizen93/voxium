#!/usr/bin/env bash
# Runs the end-to-end specs tagged @quarantine (the CI step of that name is
# non-blocking), and only when there is one to run.
#
# `playwright test --grep @quarantine --pass-with-no-tests` passes when no spec
# is tagged, but Playwright first starts every webServer of the config (the
# backend, the desktop app and the admin app) and only then finds out there is
# nothing to run. A listing (`--list`) starts nothing and takes about a second,
# so the specs are listed first.
#
# The run is skipped only when the listing succeeded AND says, in so many
# words, that it found no test. A listing that fails, or one this script cannot
# read, runs the specs as before: a mistake here must never hide a quarantined
# spec.
#
# For the step that reads the overlap reports afterwards, writes `ran=false`
# (skipped) or `ran=true` (Playwright was started) to $GITHUB_OUTPUT when that
# is set. The listing runs with PG_OVERLAP_REPORT emptied, so the overlap guard
# that NODE_OPTIONS loads stays disarmed in it and the report files hold what
# the run wrote, nothing else.
#
# Arguments are passed on to the run (the workflow gives the reporters).
set -uo pipefail

record() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "ran=$1" >> "$GITHUB_OUTPUT"
  fi
}

listing=$(PG_OVERLAP_REPORT= npx playwright test --grep @quarantine --list --pass-with-no-tests --reporter=list 2>&1)
status=$?

# Colour codes and carriage returns would only make the match below fail,
# which runs the specs: harmless, but the stack would boot for nothing
plain=$(printf '%s\n' "$listing" | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/\r$//')
if [ "$status" -eq 0 ] && printf '%s\n' "$plain" | grep -qxE 'Total: 0 tests in 0 files[[:space:]]*'; then
  echo "No spec is tagged @quarantine: nothing to run, so the stack is not started."
  record false
  exit 0
fi

if [ "$status" -ne 0 ]; then
  echo "::warning::Listing the @quarantine specs failed (exit $status); running them anyway."
fi
printf '%s\n' "$listing"
record true
exec npx playwright test --grep @quarantine --pass-with-no-tests "$@"
