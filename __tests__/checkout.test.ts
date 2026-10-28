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
