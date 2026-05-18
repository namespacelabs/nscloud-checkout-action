/**
 * Pure helpers for the `lfs-mode` input. Kept in a dedicated module so the
 * jest tests can import them without pulling in `@actions/github` and its
 * ESM-only `@octokit/*` transitive deps.
 */

export type LFSMode = 'default' | 'ref' | 'recent'
export const lfsModes: readonly LFSMode[] = ['default', 'ref', 'recent']

/**
 * Parse an `lfs-mode` action input.
 *
 * Returns the matching LFSMode or `undefined` if the input is not a recognised
 * mode. Matching is case-insensitive. The empty string is treated as missing
 * input and returns the default mode.
 */
export function parseLFSMode(input: string): LFSMode | undefined {
  const normalized = (input || 'default').toLowerCase()
  if ((lfsModes as readonly string[]).includes(normalized)) {
    return normalized as LFSMode
  }
  return undefined
}

/**
 * Build the `git lfs fetch` arg list to run against the cached mirror for a
 * given LFS mode.
 *
 * - `default`: `git lfs fetch origin` (fetches LFS for every ref the preceding
 *   `git fetch` updated; cheap on warm caches, expensive on cold caches).
 * - `ref`: `git lfs fetch origin <mirrorRef>` (scoped to the requested ref).
 * - `recent`: `git lfs fetch --recent origin` (bounded by `lfs.fetchrecent*`
 *   git config; warms recent activity without unbounded cost).
 */
export function buildMirrorLFSArgs(mirrorDir: string, lfsMode: LFSMode, mirrorRef: string): string[] {
  const base = ['--git-dir', mirrorDir, 'lfs', 'fetch']
  switch (lfsMode) {
    case 'ref':
      return [...base, 'origin', mirrorRef]
    case 'recent':
      return [...base, '--recent', 'origin']
    case 'default':
      return [...base, 'origin']
  }
}
