import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let bundle: string

beforeAll(() => {
  bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-action-'))
  execFileSync(process.execPath, [require.resolve('@vercel/ncc/dist/ncc/cli.js'), 'build', 'src/index.ts', '-o', bundle], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'pipe'
  })
}, 60000)

afterAll(() => {
  fs.rmSync(bundle, { recursive: true, force: true })
})

test.each(['missing', 'empty directory', 'non-bare repository', 'bare repository', 'bare repository without commits'])(
  'checkout recovers or reuses a mirror containing %s',
  state => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-mirror-'))
    try {
      const workspace = path.join(root, 'workspace')
      const cache = path.join(root, 'cache')
      const source = path.join(root, 'source')
      fs.mkdirSync(workspace)
      fs.mkdirSync(cache)
      const env = {
        ...process.env,
        HOME: root,
        GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'file',
        GITHUB_REPOSITORY: 'fixture/repo',
        GITHUB_WORKSPACE: workspace,
        NSC_GIT_MIRROR: cache,
        INPUT_REPOSITORY: 'fixture/repo',
        INPUT_REF: 'refs/heads/main',
        INPUT_TOKEN: 'fixture-token',
        INPUT_PATH: '',
        'INPUT_FETCH-DEPTH': '1',
        'INPUT_MAX-ATTEMPTS': '1'
      }
      const git = (...args: string[]): string => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      git('init', '--initial-branch=main', source)
      fs.writeFileSync(path.join(source, 'payload.txt'), 'checkout from local origin\n')
      git('-C', source, 'add', 'payload.txt')
      git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Fixture')
      const expectedCommit = git('-C', source, 'rev-parse', 'HEAD')
      git('config', '--global', `url.file://${source}.insteadOf`, 'https://token@github.com/fixture/repo.git')

      const uid = process.getuid?.()
      const mirror = path.join(cache, 'v2', uid === undefined || uid === 1001 ? '' : `uid-${uid}`, 'fixture-repo')
      fs.mkdirSync(path.dirname(mirror), { recursive: true })
      if (state === 'empty directory') fs.mkdirSync(mirror)
      if (state === 'non-bare repository') git('init', mirror)
      if (state === 'bare repository') git('clone', '--mirror', source, mirror)
      if (state === 'bare repository without commits') {
        git('init', '--bare', mirror)
        git('--git-dir', mirror, 'remote', 'add', '--mirror=fetch', 'origin', source)
      }
      const preserve = state.startsWith('bare repository')
      if (preserve) fs.writeFileSync(path.join(mirror, 'cache-marker'), 'preserve valid mirror')

      const result = spawnSync(process.execPath, [path.join(bundle, 'index.js')], { env, cwd: workspace, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.error?.message ?? `${result.stdout}${result.stderr}`)

      expect(git('-C', workspace, 'rev-parse', 'HEAD')).toBe(expectedCommit)
      expect(fs.readFileSync(path.join(workspace, 'payload.txt'), 'utf8')).toBe('checkout from local origin\n')
      expect(git('--git-dir', mirror, 'rev-parse', '--is-bare-repository')).toBe('true')
      if (preserve) expect(fs.readFileSync(path.join(mirror, 'cache-marker'), 'utf8')).toBe('preserve valid mirror')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
)
