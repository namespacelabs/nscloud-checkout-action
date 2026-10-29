import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

describe('checkout action', () => {
  let root: string
  let remote: string
  let workspace: string
  let env: NodeJS.ProcessEnv
  let parent: string
  let queued: string

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }

  function checkout(inputs: Record<string, string> = {}): void {
    for (const [name, value] of Object.entries(inputs)) {
      env[`INPUT_${name.toUpperCase()}`] = value
    }
    execFileSync(process.execPath, [path.resolve(__dirname, '../dist/index.js')], {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-test-'))
    remote = path.join(root, 'remote')
    workspace = path.join(root, 'workspace')
    const mirror = path.join(root, 'mirror')
    for (const dir of [remote, workspace, mirror]) fs.mkdirSync(dir)
    env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'),
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKSPACE: workspace,
      NSC_GIT_MIRROR: mirror,
      INPUT_REPOSITORY: 'owner/repo',
      'INPUT_FETCH-DEPTH': '0',
      'INPUT_MAX-ATTEMPTS': '1'
    }
    git(remote, 'config', '--global', `url.${pathToFileURL(remote).href}.insteadOf`, 'https://token@github.com/owner/repo.git')
    git(remote, 'init', '--initial-branch=main')
    git(remote, 'config', 'user.name', 'Test')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'commit', '--allow-empty', '-m', 'parent')
    parent = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'tag', 'stable')
    git(remote, 'branch', 'other')
    fs.writeFileSync(path.join(remote, 'version.txt'), 'queued\n')
    git(remote, 'add', 'version.txt')
    git(remote, 'commit', '-m', 'queued')
    queued = git(remote, 'rev-parse', 'HEAD')
    env.GITHUB_SHA = queued
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('the CI comparator rejects changed worktree contents', () => {
    checkout({ path: 'left' })
    checkout({ path: 'right' })
    const compare = () =>
      execFileSync('bash', ['-e', path.resolve(__dirname, '../.github/tests/compare-checkouts.sh'), 'left', 'right'], {
        cwd: workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

    expect(compare).not.toThrow()
    fs.writeFileSync(path.join(workspace, 'right/version.txt'), 'corrupt\n')
    expect(compare).toThrow()
    fs.unlinkSync(path.join(workspace, 'right/version.txt'))
    expect(compare).toThrow()
    fs.writeFileSync(path.join(workspace, 'right/version.txt'), 'queued\n', { mode: 0o755 })
    expect(compare).toThrow()
  })

  test.each(['1', '3'])('discovers a changed default branch after a transient failure (max-attempts=%s)', maxAttempts => {
    env.GITHUB_REPOSITORY = 'owner/workflow'
    checkout()
    expect(git(workspace, 'branch', '--show-current')).toBe('main')
    const mirror = path.dirname(fs.readFileSync(path.join(workspace, '.git/objects/info/alternates'), 'utf8').trim())

    git(remote, 'checkout', '-b', 'trunk')
    fs.writeFileSync(path.join(remote, 'version.txt'), 'new default\n')
    git(remote, 'commit', '-am', 'new default')
    const expected = git(remote, 'rev-parse', 'HEAD')

    const serveAfterFailure = path.join(root, 'serve-after-failure')
    fs.writeFileSync(
      serveAfterFailure,
      '#!/bin/sh\nset -e\nif [ ! -f "$1.failed" ]; then touch "$1.failed"; exit 1; fi\nexec git upload-pack "$@"\n',
      {
        mode: 0o755
      }
    )
    git(mirror, 'config', 'remote.origin.uploadpack', serveAfterFailure)

    workspace = path.join(root, 'second-workspace')
    fs.mkdirSync(workspace)
    env.GITHUB_WORKSPACE = workspace
    if (maxAttempts === '1') expect(() => checkout({ 'max-attempts': maxAttempts })).toThrow()
    checkout({ 'max-attempts': maxAttempts })

    expect(git(workspace, 'branch', '--show-current')).toBe('trunk')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(expected)
    expect(fs.readFileSync(path.join(workspace, 'version.txt'), 'utf8')).toBe('new default\n')
  })

  test.each(['0', '1'])('materializes the event commit LFS payload after its branch is deleted (depth=%s)', depth => {
    git(remote, 'lfs', 'install', '--skip-repo')
    git(remote, 'lfs', 'track', '*.bin')
    const payload = Buffer.from([0, 255, 12, 42, 128, 9])
    fs.writeFileSync(path.join(remote, 'payload.bin'), payload)
    git(remote, 'add', '.')
    git(remote, 'commit', '-m', 'queued LFS payload')
    const expected = git(remote, 'rev-parse', 'HEAD')
    env.GITHUB_SHA = expected
    git(remote, 'checkout', 'other')
    git(remote, 'branch', '-D', 'main')

    checkout({ lfs: 'true', 'lfs-mode': 'ref', 'fetch-depth': depth })

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(expected)
    expect(fs.readFileSync(path.join(workspace, 'payload.bin'))).toEqual(payload)
  })

  // CI supplies the upstream bundle; ordinary unit tests can also run offline.
  const referenceAction = process.env.CHECKOUT_REFERENCE_ACTION
  const compareWithUpstream = referenceAction ? test.each : test.skip.each
  compareWithUpstream(
    ['0', '1'].flatMap(depth =>
      ['advance', 'force-push', 'delete', 'orphan', 'branch', 'branch/tag collision', 'tag', 'annotated tag', 'moved tag', 'deleted pull'].map(
        scenario => [depth, scenario]
      )
    )
  )('matches actions/checkout for %s-depth %s', (depth, scenario) => {
    const inputs: Record<string, string> = { 'fetch-depth': depth }
    if (['force-push', 'delete', 'orphan', 'deleted pull'].includes(scenario)) git(remote, 'reset', '--hard', parent)
    if (['advance', 'force-push', 'delete', 'orphan', 'branch', 'branch/tag collision', 'moved tag'].includes(scenario)) {
      fs.writeFileSync(path.join(remote, 'version.txt'), 'later\n')
      git(remote, 'add', 'version.txt')
      git(remote, 'commit', '-m', 'later')
    }
    if (scenario === 'delete') {
      git(remote, 'checkout', 'other')
      git(remote, 'branch', '-D', 'main')
    }
    if (scenario === 'orphan') inputs.ref = queued
    if (scenario === 'branch' || scenario === 'branch/tag collision') inputs.ref = 'main'
    if (scenario === 'branch/tag collision') git(remote, 'tag', 'main', parent)
    if (scenario === 'tag') inputs.ref = 'stable'
    if (scenario === 'annotated tag' || scenario === 'moved tag') {
      git(remote, 'tag', '-a', 'release', '-m', 'release')
      env.GITHUB_REF = 'refs/tags/release'
    }
    if (scenario === 'deleted pull') env.GITHUB_REF = 'refs/pull/1/merge'

    const referenceWorkspace = path.join(root, 'reference-workspace')
    fs.mkdirSync(referenceWorkspace)
    git(remote, 'config', '--global', '--add', `url.${pathToFileURL(remote).href}.insteadOf`, 'https://github.com/owner/repo')
    // An existing repository avoids upstream's object-format API discovery.
    git(referenceWorkspace, 'init')
    git(referenceWorkspace, 'remote', 'add', 'origin', 'https://github.com/owner/repo')
    const runReference = () =>
      execFileSync(process.execPath, [referenceAction!], {
        cwd: referenceWorkspace,
        env: { ...env, GITHUB_WORKSPACE: referenceWorkspace, RUNNER_TEMP: root, INPUT_TOKEN: 'local-test', INPUT_CLEAN: 'false' },
        stdio: ['ignore', 'pipe', 'pipe']
      })

    if (scenario === 'moved tag') {
      expect(() => checkout(inputs)).toThrow()
      expect(runReference).toThrow()
      expect(() => git(referenceWorkspace, 'rev-parse', '--verify', 'HEAD')).toThrow()
      return
    }
    checkout(inputs)
    runReference()

    for (const args of [
      ['rev-parse', 'HEAD'],
      ['branch', '--show-current'],
      ['rev-list', '--count', 'HEAD'],
      ['rev-parse', '--is-shallow-repository'],
      ['ls-files', '--stage']
    ]) {
      expect(git(workspace, ...args)).toBe(git(referenceWorkspace, ...args))
    }
    for (const file of git(workspace, 'ls-files', '-z').split('\0').filter(Boolean)) {
      expect(fs.readFileSync(path.join(workspace, file))).toEqual(fs.readFileSync(path.join(referenceWorkspace, file)))
    }
    // Shallow fetches may include incidental extra tags upstream; full history promises all refs.
    if (depth === '0') expect(git(workspace, 'show-ref')).toBe(git(referenceWorkspace, 'show-ref'))
    if (scenario === 'annotated tag') {
      expect(git(workspace, 'rev-parse', 'refs/tags/release')).toBe(git(referenceWorkspace, 'rev-parse', 'refs/tags/release'))
    }
  })

  test.each([
    ['advance', 'false'],
    ['force-push', 'false'],
    ['delete', 'false'],
    ['force-push', 'true']
  ])('pins the event SHA after a branch %s (dissociate=%s)', (movement, dissociate) => {
    if (movement !== 'advance') git(remote, 'reset', '--hard', parent)
    fs.writeFileSync(path.join(remote, 'version.txt'), 'later\n')
    git(remote, 'add', 'version.txt')
    git(remote, 'commit', '-m', 'later')
    if (movement === 'delete') {
      git(remote, 'checkout', 'other')
      git(remote, 'branch', '-D', 'main')
    }

    checkout({ dissociate })
    if (dissociate === 'true') fs.rmSync(path.join(root, 'mirror'), { recursive: true })

    expect(fs.readFileSync(path.join(workspace, 'version.txt'), 'utf8')).toBe('queued\n')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'branch', '--show-current')).toBe('main')
    expect(git(workspace, 'rev-parse', '@{upstream}')).toBe(queued)
    expect(git(workspace, 'rev-parse', '--is-shallow-repository')).toBe('false')
    expect(git(workspace, 'rev-list', '--count', 'HEAD')).toBe('2')
    expect(git(workspace, 'rev-parse', 'refs/remotes/origin/other')).toBe(parent)
    expect(git(workspace, 'rev-parse', 'refs/tags/stable')).toBe(parent)
  })

  test.each(['0', '1'])('rejects a moved event tag at depth %s', depth => {
    env.GITHUB_REF = 'refs/tags/release'
    git(remote, 'commit', '--allow-empty', '-m', 'later')
    git(remote, 'tag', '-a', 'release', '-m', 'release')

    expect(() => checkout({ 'fetch-depth': depth })).toThrow()
    expect(() => git(workspace, 'rev-parse', '--verify', 'HEAD')).toThrow()
  })

  test.each(['0', '1'])('keeps an unchanged annotated event tag at depth %s', depth => {
    env.GITHUB_REF = 'refs/tags/release'
    git(remote, 'tag', '-a', 'release', '-m', 'release')
    const tag = git(remote, 'rev-parse', 'refs/tags/release')

    checkout({ 'fetch-depth': depth })

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'rev-parse', 'refs/tags/release')).toBe(tag)
    expect(git(workspace, 'branch', '--show-current')).toBe('')
  })

  test.each([
    ['0', 'false', ''],
    ['1', 'false', ''],
    ['0', 'true', 'blob:none'],
    ['1', 'true', 'blob:none']
  ])('checks out an orphaned explicit SHA (depth=%s, dissociate=%s, filter=%s)', (depth, dissociate, filter) => {
    git(remote, 'reset', '--hard', parent)
    git(remote, 'commit', '--allow-empty', '-m', 'later')

    checkout({ ref: queued, 'fetch-depth': depth, dissociate, filter })
    if (dissociate === 'true') fs.rmSync(path.join(root, 'mirror'), { recursive: true })

    expect(fs.readFileSync(path.join(workspace, 'version.txt'), 'utf8')).toBe('queued\n')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'show', 'HEAD:version.txt')).toBe('queued')
    expect(git(workspace, 'branch', '--show-current')).toBe('')
    expect(git(workspace, 'rev-list', '--count', 'HEAD')).toBe(depth === '0' ? '2' : '1')
  })

  test('checks out a newly orphaned commit with origin unavailable after mirror synchronization', () => {
    checkout()
    const mirror = path.dirname(fs.readFileSync(path.join(workspace, '.git/objects/info/alternates'), 'utf8').trim())

    fs.writeFileSync(path.join(remote, 'version.txt'), 'queued-after-warm\n')
    git(remote, 'commit', '-am', 'queued after warm')
    const expected = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'reset', '--hard', parent)
    git(remote, 'commit', '--allow-empty', '-m', 'later')

    const serveOnce = path.join(root, 'serve-once')
    fs.writeFileSync(serveOnce, '#!/bin/sh\nset -e\ngit upload-pack "$@"\nmv "$1" "$1.offline"\n', { mode: 0o755 })
    git(mirror, 'config', 'remote.origin.uploadpack', serveOnce)

    workspace = path.join(root, 'second-workspace')
    fs.mkdirSync(workspace)
    env.GITHUB_WORKSPACE = workspace
    env.GITHUB_SHA = expected
    checkout({ dissociate: 'true' })
    fs.rmSync(path.join(root, 'mirror'), { recursive: true })

    expect(fs.existsSync(remote)).toBe(false)
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(expected)
    expect(git(workspace, 'show', 'HEAD:version.txt')).toBe('queued-after-warm')
    expect(fs.readFileSync(path.join(workspace, 'version.txt'), 'utf8')).toBe('queued-after-warm\n')
  })

  test('refreshes a warm mirror after rewritten and deleted refs and keeps origin usable', () => {
    checkout()

    git(remote, 'reset', '--hard', parent)
    fs.writeFileSync(path.join(remote, 'version.txt'), 'rewritten\n')
    git(remote, 'add', 'version.txt')
    git(remote, 'commit', '-m', 'rewritten')
    const rewritten = git(remote, 'rev-parse', 'HEAD')
    git(remote, 'tag', '-f', 'stable')
    git(remote, 'branch', '-D', 'other')

    workspace = path.join(root, 'second-workspace')
    fs.mkdirSync(workspace)
    env.GITHUB_WORKSPACE = workspace
    env.GITHUB_SHA = rewritten
    checkout()

    expect(fs.readFileSync(path.join(workspace, 'version.txt'), 'utf8')).toBe('rewritten\n')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(rewritten)
    expect(git(workspace, 'rev-parse', 'refs/tags/stable')).toBe(rewritten)
    expect(() => git(workspace, 'rev-parse', '--verify', 'refs/remotes/origin/other')).toThrow()

    git(remote, 'checkout', '-b', 'subsequent')
    fs.writeFileSync(path.join(remote, 'version.txt'), 'subsequent\n')
    git(remote, 'commit', '-am', 'subsequent')
    git(workspace, 'fetch', 'origin', 'subsequent')
    expect(git(workspace, 'show', 'FETCH_HEAD:version.txt')).toBe('subsequent')
  })

  test('an explicit branch follows its latest tip even with a tag of the same name', () => {
    git(remote, 'tag', 'main', parent)
    fs.writeFileSync(path.join(remote, 'version.txt'), 'later\n')
    git(remote, 'commit', '-am', 'later')
    const latest = git(remote, 'rev-parse', 'HEAD')

    checkout({ ref: 'main' })

    expect(fs.readFileSync(path.join(workspace, 'version.txt'), 'utf8')).toBe('later\n')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(latest)
    expect(git(workspace, 'branch', '--show-current')).toBe('main')
  })

  test('shallow event checkouts remain pinned', () => {
    git(remote, 'commit', '--allow-empty', '-m', 'later')

    checkout({ 'fetch-depth': '1' })

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'branch', '--show-current')).toBe('main')
    expect(git(workspace, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  test('checks out a deleted pull ref by its event SHA', () => {
    env.GITHUB_REF = 'refs/pull/1/merge'
    git(remote, 'reset', '--hard', parent)

    checkout()

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'branch', '--show-current')).toBe('')
    expect(git(workspace, 'rev-parse', 'refs/remotes/pull/1/merge')).toBe(queued)
  })

  test('fails instead of checking out a different commit when the event SHA is unavailable', () => {
    env.GITHUB_SHA = 'f'.repeat(40)

    expect(() => checkout()).toThrow()
    expect(() => git(workspace, 'rev-parse', '--verify', 'HEAD')).toThrow()
  })
})
