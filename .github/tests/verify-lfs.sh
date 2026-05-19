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
echo "lfs-file.bin size: ${LFS_SIZE} bytes (not an LFS pointer)"
