#!/bin/bash -e
dir=$1
commit=$2
ref=$3

echo "::group::Compare HEAD commit (want | got)"
sdiff <(echo "$commit") <(git "--git-dir=$dir/.git" rev-parse HEAD) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare fetched refs (want | got)"
sdiff <(echo "$commit $ref") <(git "--git-dir=$dir/.git" show-ref) && echo same || exit 1
echo ::endgroup::