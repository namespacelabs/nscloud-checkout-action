#!/bin/bash -e
gh=$1
ns=$2

echo "::group::Compare HEAD commit (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" rev-parse HEAD) <(git "--git-dir=$ns/.git" rev-parse HEAD) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare branch name (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" branch --show-current) <(git "--git-dir=$ns/.git" branch --show-current) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare fetched refs (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" show-ref) <(git "--git-dir=$ns/.git" show-ref) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare history and shallow state (gh | ns)"
sdiff <(git -C "$gh" rev-list --all | sort) <(git -C "$ns" rev-list --all | sort) && echo same || exit 1
sdiff <(git -C "$gh" rev-parse --is-shallow-repository) <(git -C "$ns" rev-parse --is-shallow-repository) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare worktree contents (gh | ns)"
diff -r -x .git "$gh" "$ns" || exit 1
git -C "$gh" diff --exit-code HEAD || exit 1
git -C "$ns" diff --exit-code HEAD || exit 1
echo ::endgroup::
