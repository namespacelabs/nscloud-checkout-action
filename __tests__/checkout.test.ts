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
    git(remote, 'commit', '--allow-empty', '-m', 'queued')
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
    git(remote, 'commit', '--allow-empty', '-m', 'later')
    if (movement === 'delete') {
      git(remote, 'checkout', 'other')
      git(remote, 'branch', '-D', 'main')
    }

    checkout({ dissociate })
    if (dissociate === 'true') fs.rmSync(path.join(root, 'mirror'), { recursive: true })

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'branch', '--show-current')).toBe('main')
    expect(git(workspace, 'rev-parse', '@{upstream}')).toBe(queued)
    expect(git(workspace, 'rev-parse', '--is-shallow-repository')).toBe('false')
    expect(git(workspace, 'rev-list', '--count', 'HEAD')).toBe('2')
    expect(git(workspace, 'rev-parse', 'refs/remotes/origin/other')).toBe(parent)
    expect(git(workspace, 'rev-parse', 'refs/tags/stable')).toBe(parent)
  })

  test('pins a moved event tag without creating a branch', () => {
    env.GITHUB_REF = 'refs/tags/release'
    git(remote, 'commit', '--allow-empty', '-m', 'later')
    git(remote, 'tag', '-a', 'release', '-m', 'release')

    checkout()

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'branch', '--show-current')).toBe('')
    expect(git(workspace, 'rev-list', '--count', 'HEAD')).toBe('2')
  })

  test('keeps an unchanged annotated event tag', () => {
    env.GITHUB_REF = 'refs/tags/release'
    git(remote, 'tag', '-a', 'release', '-m', 'release')
    const tag = git(remote, 'rev-parse', 'refs/tags/release')

    checkout()

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'rev-parse', 'refs/tags/release')).toBe(tag)
  })

  test.each(['0', '1'])('checks out an orphaned explicit SHA at depth %s', depth => {
    git(remote, 'reset', '--hard', parent)
    git(remote, 'commit', '--allow-empty', '-m', 'later')

    checkout({ ref: queued, 'fetch-depth': depth })

    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(queued)
    expect(git(workspace, 'branch', '--show-current')).toBe('')
    expect(git(workspace, 'rev-list', '--count', 'HEAD')).toBe(depth === '0' ? '2' : '1')
  })

  test('an explicit branch still follows its latest tip', () => {
    git(remote, 'commit', '--allow-empty', '-m', 'later')
    const latest = git(remote, 'rev-parse', 'HEAD')

    checkout({ ref: 'main' })

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
