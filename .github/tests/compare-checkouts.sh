#!/bin/bash -e
gh=$1
ns=$2
f=$3

echo "::group::Compare HEAD commit (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" rev-parse HEAD) <(git "--git-dir=$ns/.git" rev-parse HEAD) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare branch name (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" branch --show-current) <(git "--git-dir=$ns/.git" branch --show-current) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare fetched refs (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" show-ref) <(git "--git-dir=$ns/.git" show-ref) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare $f"
cmp --silent -- "$gh/$f" "$ns/$f" && echo same
echo ::endgroup::