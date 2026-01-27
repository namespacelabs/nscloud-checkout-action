#!/bin/bash -e
gh=$1
ns=$2

echo "::group::Compare HEAD commit (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" rev-parse HEAD) <(git "--git-dir=$ns/.git" rev-parse HEAD) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare sparse-checkout config (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" config --get core.sparseCheckout) <(git "--git-dir=$ns/.git" config --get core.sparseCheckout) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare sparse-checkout patterns (gh | ns)"
sdiff <(git "--git-dir=$gh/.git" sparse-checkout list | sort) <(git "--git-dir=$ns/.git" sparse-checkout list | sort) && echo same || exit 1
echo ::endgroup::

echo "::group::Compare checked out files (gh | ns)"
sdiff <(find "$gh" -type f ! -path '*/.git/*' | sed "s|^$gh/||" | sort) <(find "$ns" -type f ! -path '*/.git/*' | sed "s|^$ns/||" | sort) && echo same || exit 1
echo ::endgroup::

echo "::group::Verify sparse directories exist"
test -d "$ns/src" && echo "src/ exists" || exit 1
test -d "$ns/.github" && echo ".github/ exists" || exit 1
echo ::endgroup::

echo "::group::Verify non-sparse directories do NOT exist"
if [ -d "$ns/dist" ]; then
  echo "ERROR: dist/ should not exist in sparse checkout"
  exit 1
fi
echo "dist/ correctly excluded"
echo ::endgroup::
