#!/bin/bash
#
# Verify a checkout that requested `lfs: true`.
#
# Usage: verify-lfs.sh [<repo-path>]   (default: lfs)
#
set -euo pipefail

REPO_PATH="${1:-lfs}"

if [ ! -f "${REPO_PATH}/regular-file.txt" ]; then
    echo "Expected regular file does not exist"
    exit 1
fi

if [ ! -f "${REPO_PATH}/lfs-file.bin" ]; then
    echo "Expected lfs file does not exist"
    exit 1
fi

if head -c 40 "${REPO_PATH}/lfs-file.bin" | grep -q '^version https://git-lfs'; then
    echo "ERROR: lfs-file.bin still contains an LFS pointer (smudge did not run)"
    head -c 200 "${REPO_PATH}/lfs-file.bin"
    exit 1
fi

LFS_SIZE=$(stat -c %s "${REPO_PATH}/lfs-file.bin" 2>/dev/null || stat -f %z "${REPO_PATH}/lfs-file.bin")
EXPECTED_SIZE=$(git -C "$REPO_PATH" show HEAD:lfs-file.bin | sed -n 's/^size //p')
EXPECTED_SHA=$(git -C "$REPO_PATH" show HEAD:lfs-file.bin | sed -n 's/^oid sha256://p')
LFS_SHA=$(shasum -a 256 "${REPO_PATH}/lfs-file.bin" | awk '{print $1}')
if [ "$LFS_SIZE" != "$EXPECTED_SIZE" ] || [ "$LFS_SHA" != "$EXPECTED_SHA" ]; then
    echo "ERROR: lfs-file.bin does not match the committed LFS pointer"
    exit 1
fi
echo "lfs-file.bin matches the committed SHA-256 and size (${LFS_SIZE} bytes)"
