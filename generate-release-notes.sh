#!/usr/bin/env bash
set -euo pipefail

# Simple release notes generator
# Usage: ./generate-release-notes.sh [from-ref] [to-ref]   (run from the repository root)
# If no from-ref is provided, the script will use the latest tag; if none, uses the initial commit.

FROM_REF=${1-}
TO_REF=${2-HEAD}

if [ -z "$FROM_REF" ]; then
  # find latest tag reachable from HEAD
  if git describe --tags --abbrev=0 >/dev/null 2>&1; then
    FROM_REF=$(git describe --tags --abbrev=0)
  else
    FROM_REF=$(git rev-list --max-parents=0 HEAD)
  fi
fi

echo "Generating release notes from $FROM_REF to $TO_REF"

echo
echo "## Changes ($FROM_REF..$TO_REF)"
echo

git log --pretty=format:"- %s (%an)" "$FROM_REF".."$TO_REF"
