import { LFSMode, buildMirrorLFSArgs, lfsModes, parseLFSMode } from '../src/lfs'

describe('parseLFSMode', () => {
  test.each(lfsModes)('accepts %s', mode => {
    expect(parseLFSMode(mode)).toBe(mode)
  })

  test.each([
    ['DEFAULT', 'default'],
    ['Ref', 'ref'],
    ['RECENT', 'recent']
  ])('is case-insensitive: %s -> %s', (input, expected) => {
    expect(parseLFSMode(input)).toBe(expected)
  })

  test('empty input falls back to default', () => {
    expect(parseLFSMode('')).toBe('default')
  })

  test.each(['all', 'none', 'true', 'recent-ish', ' recent', 'recent '])('rejects unknown value %j', value => {
    expect(parseLFSMode(value)).toBeUndefined()
  })

  test('lfsModes only contains expected values', () => {
    expect([...lfsModes].sort()).toEqual(['default', 'recent', 'ref'])
  })
})

describe('buildMirrorLFSArgs', () => {
  const mirrorDir = '/cache/v2/owner-repo'
  // Mirror-local ref name. `--mirror` clones keep refs in their original
  // namespace, so callers MUST pass a mirror-local ref here (e.g.
  // refs/heads/...), not the workdir's refs/remotes/origin/... form.
  const mirrorRef = 'refs/heads/feature'

  test('default mode pulls LFS for every ref the mirror fetch updated', () => {
    expect(buildMirrorLFSArgs(mirrorDir, 'default', mirrorRef)).toEqual(['--git-dir', mirrorDir, 'lfs', 'fetch', 'origin'])
  })

  test('ref mode scopes the fetch to the checked-out ref', () => {
    expect(buildMirrorLFSArgs(mirrorDir, 'ref', mirrorRef)).toEqual(['--git-dir', mirrorDir, 'lfs', 'fetch', 'origin', mirrorRef])
  })

  test('ref mode passes the mirrorRef verbatim (no --recent flag)', () => {
    const args = buildMirrorLFSArgs(mirrorDir, 'ref', mirrorRef)
    expect(args).not.toContain('--recent')
    expect(args[args.length - 1]).toBe(mirrorRef)
  })

  test('recent mode uses --recent and does NOT pin to a specific ref', () => {
    const args = buildMirrorLFSArgs(mirrorDir, 'recent', mirrorRef)
    expect(args).toEqual(['--git-dir', mirrorDir, 'lfs', 'fetch', '--recent', 'origin'])
    expect(args).not.toContain(mirrorRef)
  })

  test('every mode targets the same mirror via --git-dir and the same `origin` remote', () => {
    for (const mode of lfsModes) {
      const args = buildMirrorLFSArgs(mirrorDir, mode, mirrorRef)
      expect(args.slice(0, 4)).toEqual(['--git-dir', mirrorDir, 'lfs', 'fetch'])
      expect(args).toContain('origin')
    }
  })

  test('all modes are exhaustively handled (compile-time + runtime)', () => {
    // Sanity: a TS-exhaustive switch should produce a non-empty arg list for
    // every declared mode. If a new LFSMode is added without updating
    // buildMirrorLFSArgs, this test (and TypeScript) will surface it.
    const seen = new Set<LFSMode>()
    for (const mode of lfsModes) {
      const args = buildMirrorLFSArgs(mirrorDir, mode, mirrorRef)
      expect(args.length).toBeGreaterThan(0)
      seen.add(mode)
    }
    expect(seen.size).toBe(lfsModes.length)
  })
})
