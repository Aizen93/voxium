#!/usr/bin/env bash
# The commits ci.yml's Security Scan gives gitleaks, and the scan itself.
#
# gitleaks-action v3.0.0 listed a pull request's commits without paging (the
# first 30) and scanned `--no-merges --first-parent <first>^..<30th>`, and a
# push the same way between the event's first and last commit. A pull
# request was scanned up to its 30th commit only (every release pull request
# logged far fewer commits than it held), a commit of a branch merged into it
# never, and a merge-commit push not at all ("0 commits scanned").
#
# This scans:
#   pull_request  every commit the pull request adds: BASE_SHA..HEAD_SHA,
#                 the commits of the branches merged into it included;
#   push          every commit the push adds: BEFORE_SHA..AFTER_SHA, merged
#                 branches included. With no usable BEFORE_SHA (a new branch,
#                 all zeros; a force-push whose old tip this clone does not
#                 hold) every commit reachable from AFTER_SHA;
#   anything else every commit reachable from HEAD.
# A merge commit is read with --remerge-diff (git 2.36 or later): what the
# merge holds beyond merging its parents again automatically, which is the
# resolution of a conflict or anything else changed while merging. A clean
# merge adds nothing there, and every commit it merges is scanned on its own.
# (Without it git log shows no diff for a merge, and a line written only while
# resolving a conflict was never read.)
#
# Usage, from the root of a full clone (actions/checkout fetch-depth: 0):
#   secret-scan.sh <gitleaks binary>
# Environment: EVENT_NAME; BASE_SHA and HEAD_SHA, or BEFORE_SHA and AFTER_SHA.
# Every value arrives through the environment, never through the workflow's
# expressions inside a script. Exit status: gitleaks' (1 for a finding or a
# failed scan), or 1 when the range cannot be set.
#
# POSIX sh on purpose: CI runs it with bash, and it also runs under the
# gitleaks image's sh.
set -eu

gitleaks=${1:?usage: secret-scan.sh <gitleaks binary>}
ZERO=0000000000000000000000000000000000000000

fail() {
  echo "::error::$1"
  exit 1
}

# --remerge-diff (below) needs git 2.36 or later
version=$(git version)
major=$(echo "$version" | sed -n 's/^git version \([0-9][0-9]*\)\..*/\1/p')
minor=$(echo "$version" | sed -n 's/^git version [0-9][0-9]*\.\([0-9][0-9]*\).*/\1/p')
if [ -z "$major" ] || [ -z "$minor" ] || [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 36 ]; }; then
  fail "git 2.36 or later is needed to read what merges add (--remerge-diff); this is '$version'"
fi

# A full commit id: 40 lowercase hex digits, nothing else
full_id() {
  case "$1" in
    *[!0-9a-f]* | '') return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

in_clone() {
  git cat-file -e "$1^{commit}" 2>/dev/null
}

# need <what> <value>: a full commit id this clone holds, or the step fails
need() {
  full_id "$2" || fail "$1 '$2' is not a full commit id"
  in_clone "$2" || fail "$1 '$2' is not in this clone"
}

case "${EVENT_NAME:-}" in
  pull_request)
    need "the pull request's base commit" "${BASE_SHA:-}"
    need "the pull request's head commit" "${HEAD_SHA:-}"
    range="$BASE_SHA..$HEAD_SHA"
    ;;
  push)
    need "the pushed commit" "${AFTER_SHA:-}"
    before=${BEFORE_SHA:-}
    if [ -z "$before" ] || [ "$before" = "$ZERO" ]; then
      echo "A new branch: every commit reachable from $AFTER_SHA is scanned."
      range="$AFTER_SHA"
    elif ! full_id "$before"; then
      fail "the previous tip '$before' is not a full commit id"
    elif ! in_clone "$before"; then
      echo "The previous tip $before is not in this clone (a force-push): every commit reachable from $AFTER_SHA is scanned."
      range="$AFTER_SHA"
    else
      range="$before..$AFTER_SHA"
    fi
    ;;
  *)
    echo "Event '${EVENT_NAME:-}': every commit reachable from HEAD is scanned."
    range=HEAD
    ;;
esac

count=$(git rev-list --count "$range")
echo "Scanning $count commits: $range"
exec "$gitleaks" git --no-banner --redact --verbose \
  --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore \
  --log-opts="--remerge-diff $range" .
