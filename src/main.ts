import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'
import * as fs from 'node:fs'
import * as path from 'node:path'

const version = 'v2'

export async function main(): Promise<void> {
  try {
    const config = parseInputConfig()

    const gitMirrorPath = process.env.NSC_GIT_MIRROR
    core.debug(`Git mirror path ${gitMirrorPath}`)
    if (!gitMirrorPath || !fs.existsSync(gitMirrorPath)) {
      let hint = `Please update your \x1b[1mruns-on\x1b[0m labels. E.g.:
      
  \x1b[32mruns-on\x1b[34m:\x1b[0m
    - \x1b[34mnscloud-ubuntu-22.04-amd64-8x16-\x1b[1mwith-cache\x1b[0m
    - \x1b[34m\x1b[1mnscloud-git-mirror-5gb\x1b[0m`

      if (process.env.NSC_RUNNER_PROFILE_INFO) {
        hint = 'Please enable \x1b[1mGit repository checkouts\x1b[0m in your runner profile cache settings.'
      }

      throw new Error(`nscloud-checkout-action requires Git caching to be enabled.

${hint}

See also https://namespace.so/docs/solutions/github-actions/caching#git-checkouts`)
    }

    const workspacePath = process.env.GITHUB_WORKSPACE
    core.debug(`Workspace path ${workspacePath}`)
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error(`GitHub Runner workspace is not set GITHUB_WORKSPACE = ${workspacePath}.`)
    }

    core.startGroup('Set up Git configuration')
    // Set authentication
    await configGitAuth(config.token, { global: true })
    core.endGroup()

    core.startGroup('Update checkout cache')
    // Prepare mirror if does not exist
    // Layout depends on version:
    // v1/ path was introduced with v1 tag because the way we cloned the mirror in v0 was not
    // compatible with caching submodules, so we had to change the mirror repo directory to force a re-clone.
    // v2/ path was introduced to fix a bug in the way a shallow mirror repo worked when referenced by a cloned
    // repo with submodules, in that case caching did not happen, so we restore in v2 the mirror repo as is used to be in v0
    // and not attempt to cache also recursive submodules.
    const remoteURL = `https://token@github.com/${config.owner}/${config.repo}.git`
    const mirrorDir = path.join(gitMirrorPath, `${version}/${config.owner}-${config.repo}`)
    if (!fs.existsSync(mirrorDir)) {
      fs.mkdirSync(mirrorDir, { recursive: true })
      await execWithGitEnv('git', ['clone', '--mirror', '--', remoteURL, mirrorDir], config.maxAttempts)
    }

    // Fetch commits for mirror
    await execWithGitEnv(
      'git',
      ['-c', 'protocol.version=2', '--git-dir', mirrorDir, 'fetch', '--no-recurse-submodules', '--prune', '--prune-tags', 'origin'],
      config.maxAttempts
    )

    // If Git LFS is required, download objects in cache
    if (config.downloadGitLFS) {
      await execWithGitEnv('git', ['--git-dir', mirrorDir, 'lfs', 'fetch', 'origin'], config.maxAttempts)
    }
    core.endGroup()

    if (core.isDebug()) {
      core.startGroup('Mirrored refs')
      await exec.exec('git', ['--git-dir', mirrorDir, 'show-ref'])
      core.endGroup()
    }

    core.startGroup('Fetch using the cache')
    // Resolve references.
    const checkoutInfo = await getCheckoutInfo(config.ref, config.commit, config.fetchDepth, mirrorDir)

    // Prepare repo dir
    let repoDir = workspacePath
    if (config.targetPath) {
      repoDir = path.join(workspacePath, config.targetPath)
    }

    // Clone the repo.
    // We don't use git-clone to have full control over the configuration of remote
    // and what we are fetching from the remote vs the mirror (see NSL-6774, NSL-6725, NSL-6825).
    await exec.exec('git', ['-c', 'advice.defaultBranchName=false', 'init', repoDir])
    await exec.exec(`git config --global --add safe.directory ${repoDir}`)

    const gitRepoFlags = ['--git-dir', `${repoDir}/.git`, '--work-tree', repoDir]
    await exec.exec('git', [...gitRepoFlags, 'remote', 'add', 'origin', remoteURL])

    // Fetch the refs
    const fetchDepthFlags = config.fetchDepth <= 0 ? [] : ['--depth', config.fetchDepth.toString(), '--no-tags']
    const filterFlags = config.filter === '' ? [] : ['--filter', config.filter]
    const referenceEnv = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(mirrorDir, 'objects')
    }
    await execWithGitEnv(
      'git',
      [
        ...gitRepoFlags,
        'fetch',
        '-v',
        '--prune',
        '--progress',
        '--no-recurse-submodules',
        ...fetchDepthFlags,
        ...filterFlags,
        'origin',
        ...checkoutInfo.fetchRefs
      ],
      config.maxAttempts,
      { env: referenceEnv }
    )
    core.endGroup()

    // If Git LFS is required, download objects. This should use the mirror cached LFS objects.
    if (config.downloadGitLFS) {
      core.startGroup('Fetch LFS resources')
      await execWithGitEnv('git', [...gitRepoFlags, 'lfs', 'fetch', 'origin', checkoutInfo.pointerRef], config.maxAttempts, {
        env: referenceEnv
      })
      core.endGroup()
    }

    // Write the configuration to use the mirror always.
    if (config.dissociateMainRepo) {
      core.startGroup(`Dissociate checkout from cache`)
      // No retries: repack is a local operation
      await execWithGitEnv('git', [...gitRepoFlags, 'repack', '-a', '-d'], 1, { env: referenceEnv })
      core.endGroup()
    } else {
      const alternatesPath = path.join(repoDir, '.git/objects/info/alternates')
      fs.writeFileSync(alternatesPath, path.join(mirrorDir, 'objects'))
    }

    core.startGroup(`Check out ${checkoutInfo.pointerRef}`)
    // Checkout the ref
    const smudgeEnv = { GIT_LFS_SKIP_SMUDGE: config.downloadGitLFS ? '0' : '1' }
    const startBranchFlags = checkoutInfo.startBranch ? ['-B', checkoutInfo.startBranch] : []
    // No retries: checkout is a local operation
    await execWithGitEnv(
      'git',
      [...gitRepoFlags, 'checkout', '--progress', '--force', ...startBranchFlags, checkoutInfo.pointerRef],
      1,
      { env: { ...smudgeEnv, ...referenceEnv } }
    )
    core.endGroup()

    // Clone submodules in repo
    if (config.submodules) {
      core.startGroup('Update submodules')
      await gitSubmoduleUpdate(config, gitMirrorPath, repoDir)
      core.endGroup()
    }

    core.startGroup('Reset Git authentication')
    if (config.persistCredentials) {
      // Persist authentication in local
      await configGitAuth(config.token, { repoDir })
      // Set auth for submodules
      await configGitAuthForSubmodules(config.token, repoDir)
    }

    // Cleanup global authentication config
    await cleanupGitAuth({ global: true })
    core.endGroup()
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

interface IInputConfig {
  owner: string
  repo: string
  isWorkflowRepository: boolean
  commit: string
  ref: string
  token: string
  fetchDepth: number
  filter: string
  targetPath: string
  submodules: boolean
  nestedSubmodules: boolean
  dissociateMainRepo: boolean
  dissociateSubmodules: boolean
  persistCredentials: boolean
  downloadGitLFS: boolean
  maxAttempts: number
}

function parseInputConfig(): IInputConfig {
  const result = {} as unknown as IInputConfig

  const ownerRepo = core.getInput('repository') // owner/repository
  core.debug(`Repository ${ownerRepo}`)
  const splitRepo = ownerRepo.split('/')
  result.owner = splitRepo[0]
  result.repo = splitRepo[1]

  // Workflow repository?
  result.isWorkflowRepository = ownerRepo.toUpperCase() === `${github.context.repo.owner}/${github.context.repo.repo}`.toUpperCase()

  result.ref = core.getInput('ref')
  result.commit = core.getInput('commit') // hidden input for testing
  if (!result.ref) {
    if (result.isWorkflowRepository) {
      result.ref = github.context.ref
      result.commit = github.context.sha

      // Some events have an unqualifed ref. For example when a PR is merged (pull_request closed event),
      // the ref is unqualifed like "main" instead of "refs/heads/main".
      if (result.commit && result.ref && !result.ref.startsWith('refs/')) {
        result.ref = `refs/heads/${result.ref}`
      }
    }
  } else if (result.ref.match(/^[0-9a-fA-F]{40}$/)) {
    // SHA
    result.commit = result.ref
    result.ref = ''
  }
  core.debug(`Ref ${result.ref}`)
  core.debug(`Commit ${result.commit}`)

  result.token = core.getInput('token')
  result.fetchDepth = Number(core.getInput('fetch-depth'))
  core.debug(`Depth ${result.fetchDepth}`)

  result.filter = core.getInput('filter')
  core.debug(`Filter ${result.filter}`)

  result.targetPath = core.getInput('path')
  core.debug(`Path ${result.targetPath}`)

  // Submodules
  result.submodules = false
  result.nestedSubmodules = false
  const submodulesString = (core.getInput('submodules') || '').toUpperCase()
  if (submodulesString === 'RECURSIVE') {
    result.submodules = true
    result.nestedSubmodules = true
  } else if (submodulesString === 'TRUE') {
    result.submodules = true
  }
  core.debug(`submodules = ${result.submodules}`)
  core.debug(`recursive submodules = ${result.nestedSubmodules}`)

  // Dissociate
  result.dissociateMainRepo = false
  result.dissociateSubmodules = false
  const dissociateString = (core.getInput('dissociate') || '').toUpperCase()
  if (dissociateString === 'RECURSIVE') {
    result.dissociateMainRepo = true
    result.dissociateSubmodules = true
  } else if (dissociateString === 'TRUE') {
    result.dissociateMainRepo = true
  }
  core.debug(`dissociateMainRepo = ${result.dissociateMainRepo}`)
  core.debug(`dissociateSubmodules = ${result.dissociateSubmodules}`)

  const persistCredentialsString = (core.getInput('persist-credentials') || '').toUpperCase()
  if (persistCredentialsString === 'TRUE') {
    result.persistCredentials = true
  } else {
    result.persistCredentials = false
  }
  core.debug(`persistCredentials = ${result.persistCredentials}`)

  // Download and cache Git LFS objects
  const downloadGitLFS = (core.getInput('lfs') || '').toUpperCase()
  if (downloadGitLFS === 'TRUE') {
    result.downloadGitLFS = true
  } else {
    result.downloadGitLFS = false
  }
  core.debug(`downloadGitLFS = ${result.downloadGitLFS}`)

  result.maxAttempts = Math.max(1, Number(core.getInput('max-attempts')) || 3)
  core.debug(`maxAttempts = ${result.maxAttempts}`)

  return result
}

interface ICheckoutInfo {
  originalRef: string // that's how the remote calls the target (e.g. refs/heads/xxx).
  pointerRef: string // that's how we will call the fetched ref (e.g. refs/remotes/origin/xxx).
  startBranch?: string // that's how we will call the branch we create to track remoteRef
  fetchRefs: string[]
}

async function getCheckoutInfo(ref: string, commit: string, depth: number, mirrorDir: string): Promise<ICheckoutInfo> {
  // Nothing specified => find the default branch and use it as `ref`.
  if (!ref && !commit) {
    core.debug('No ref or commit => determine default branch')
    // Luckily we have a faithful mirror of the remote locally, just resolve its HEAD.
    const output = await exec.getExecOutput('git', ['--git-dir', mirrorDir, 'symbolic-ref', '--quiet', 'HEAD'])
    ref = output.stdout.trim()
    core.debug(`Detected default branch ${ref}`)
  }

  // Unqualified ref => resolve using normal Git rules.
  if (ref && !ref.toUpperCase().startsWith('REFS/')) {
    core.debug('Unqualified ref => resolve')
    const output = await exec.getExecOutput('git', ['--git-dir', mirrorDir, 'rev-parse', '--verify', '--symbolic-full-name', ref])
    ref = output.stdout.trim()
    core.debug(`Detected fully-qualified ref ${ref}`)
  }

  const result = {} as ICheckoutInfo

  // refs/heads/
  const upperRef = ref.toUpperCase()
  if (upperRef.startsWith('REFS/HEADS/')) {
    core.debug('Processing branch ref')
    const branch = ref.substring('refs/heads/'.length)
    result.originalRef = ref
    result.pointerRef = `refs/remotes/origin/${branch}`
    result.startBranch = branch
  }
  // refs/pull/
  else if (upperRef.startsWith('REFS/PULL/')) {
    core.debug('Processing pull ref')
    const branch = ref.substring('refs/pull/'.length)
    result.originalRef = ref
    result.pointerRef = `refs/remotes/pull/${branch}`
  }
  // all other, mostly tags - mirror
  else if (ref) {
    core.debug('Processing generic ref')
    result.originalRef = ref
    result.pointerRef = ref
  }
  // no ref, only commit
  else {
    core.debug('Processing commit without ref')
    result.originalRef = commit
    result.pointerRef = commit
  }

  if (depth > 0) {
    // Only fetch the requested ref
    if (ref) {
      result.fetchRefs = [`+${commit || ref}:${result.pointerRef}`]
    } else {
      result.fetchRefs = [commit]
    }
  } else {
    result.fetchRefs = ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']
    if (ref && !upperRef.startsWith('REFS/HEADS/') && !upperRef.startsWith('REFS/TAGS/')) {
      result.fetchRefs.push(`+${commit || ref}:${result.pointerRef}`)
    }
  }

  core.debug(`originalRef = ${result.originalRef}`)
  core.debug(`pointerRef = ${result.pointerRef}`)
  core.debug(`startBranch = ${result.startBranch}`)
  core.debug(`fetchRefs = ${result.fetchRefs}`)

  return result
}

async function configGitAuthForSubmodules(token: string, repoDir: string) {
  // Set authentication
  const basicCredential = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  core.setSecret(basicCredential)

  await exec.exec(
    `git submodule foreach --recursive sh -c "git config --local --add 'http.https://github.com/.extraheader' 'AUTHORIZATION: basic ${basicCredential}'"`,
    [],
    { cwd: repoDir ? repoDir : undefined }
  )
  await exec.exec(`git submodule foreach --recursive sh -c "git config --local --add 'url.https://github.com/.insteadOf' 'git@github.com:'"`, [], {
    cwd: repoDir ? repoDir : undefined
  })
}

async function configGitAuth(token: string, opts: { global: true } | { repoDir: string }) {
  // Set authentication
  const basicCredential = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  core.setSecret(basicCredential)

  let configSelector = 'global' in opts && opts.global ? '--global' : '--local'
  const cwd = 'repoDir' in opts ? opts.repoDir : undefined

  // (NSL-2981) Remove previous extra auth header if any
  await exec.exec('git', ['config', configSelector, '--unset-all', 'http.https://github.com/.extraheader'], { ignoreReturnCode: true, cwd })
  await exec.exec('git', ['config', configSelector, '--add', 'http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basicCredential}`], {
    cwd
  })
  await exec.exec('git', ['config', configSelector, '--add', 'url.https://github.com/.insteadOf', 'git@github.com:'], { cwd })
}

async function cleanupGitAuth(opts: { global: true } | { repoDir: string }) {
  let configSelector = 'global' in opts && opts.global ? '--global' : '--local'
  const cwd = 'repoDir' in opts ? opts.repoDir : undefined

  await exec.exec('git', ['config', configSelector, '--unset-all', 'http.https://github.com/.extraheader'], { ignoreReturnCode: true, cwd })
  await exec.exec('git', ['config', configSelector, '--unset-all', 'url.https://github.com/.insteadOf'], { ignoreReturnCode: true, cwd })
}

const gitEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never'
}

// Similar to exec.exec, but options.env is interpreted as variables to add (as opposed to replacing the env).
async function execWithGitEnv(
  commandLine: string,
  args: string[],
  maxAttempts: number,
  options?: exec.ExecOptions
): Promise<number> {
  const env = {
    ...(process.env as Record<string, string>),
    ...gitEnv,
    ...options?.env
  }
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await exec.exec(commandLine, args, { ...options, env })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxAttempts) {
        const delay = attempt * 1000
        core.warning(`Command failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${lastError.message}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}

async function gitSubmoduleUpdate(config: IInputConfig, mirrorDir: string, repoDir: string) {
  const recursiveFlag = config.nestedSubmodules ? ['--recurse'] : []
  const fetchDepthFlag = config.fetchDepth <= 0 ? [] : ['--depth', config.fetchDepth.toString()]
  const filterFlags = config.filter === '' ? [] : ['--filter', config.filter]
  const dissociateFlag = config.dissociateSubmodules ? ['--dissociate'] : []
  const debugFlag = core.isDebug() ? ['--debug_to_console'] : []
  await execWithGitEnv(
    'nsc',
    [
      'git-checkout',
      'update-submodules',
      '--mirror_base_path',
      mirrorDir,
      '--repository_path',
      repoDir,
      ...recursiveFlag,
      ...fetchDepthFlag,
      ...filterFlags,
      ...dissociateFlag,
      ...debugFlag
    ],
    config.maxAttempts
  )
}
