import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'

const version = 'v2'

export async function run(): Promise<void> {
  try {
    const config = parseInputConfig()

    const gitMirrorPath = process.env.NSC_GIT_MIRROR
    core.debug(`Git mirror path ${gitMirrorPath}`)
    if (!gitMirrorPath || !fs.existsSync(gitMirrorPath)) {
      throw new Error('Experimental git mirror feature must be enabled.')
    }

    const workspacePath = process.env.GITHUB_WORKSPACE
    core.debug(`Workspace path ${workspacePath}`)
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error(
        `GitHub Runner workspace is not set GITHUB_WORKSPACE = ${workspacePath}.`
      )
    }

    // Set authentication
    await configGitGlobalAuth(config.token)

    // Prepare mirror if does not exist
    // Layout depends on version:
    // v1/ path was introduced with v1 tag because the way we cloned the mirror in v0 was not
    // compatible with caching submodules, so we had to change the mirror repo directory to force a re-clone.
    // v2/ path was introduced to fix a bug in the way a shallow mirror repo worked when referenced by a cloned
    // repo with submodules, in that case caching did not happen, so we restore in v2 the mirror repo as is used to be in v0
    // and not attempt to cache also recursive submodules.
    const mirrorDir = path.join(
      gitMirrorPath,
      `${version}/${config.owner}-${config.repo}`
    )
    if (!fs.existsSync(mirrorDir)) {
      fs.mkdirSync(mirrorDir, { recursive: true })
      await gitClone(config.owner, config.repo, mirrorDir, ['--mirror'])
    }

    // Fetch commits for mirror
    await gitFetch(mirrorDir)

    // Prepare repo dir
    let repoDir = workspacePath
    if (config.targetPath) {
      repoDir = path.join(workspacePath, config.targetPath)
    }

    // Clone the repo
    await exec.exec(`git config --global --add safe.directory ${repoDir}`)
    const fetchDepthFlag = getFetchDepthFlag(config)
    const dissociateFlag = config.dissociateMainRepo ? '--dissociate' : ''
    await gitClone(config.owner, config.repo, repoDir, [
      `--reference=${mirrorDir}`,
      `${fetchDepthFlag}`,
      `${dissociateFlag}`
    ])

    // Clone submodules in repo
    if (config.submodules) {
      await gitSubmoduleUpdate(config, gitMirrorPath, repoDir)
    }

    // When ref is unspecified and for repositories different from the one where the workflow is running
    // resolve their default branch and use it as `ref`
    let ref = config.ref
    const commit = config.commit
    if (!ref && !config.isWorkflowRepository) {
      const output = await exec.getExecOutput(
        `git --git-dir ${repoDir}/.git --work-tree ${repoDir} symbolic-ref refs/remotes/origin/HEAD --short`
      )
      for (let line of output.stdout.trim().split('\n')) {
        line = line.trim()
        if (line.startsWith('origin/')) {
          ref = `refs/heads/${line.split('/')[1].trim()}`
        }
      }
    }

    // Fetch the ref
    const fetchInfo = getFetchInfo(ref, commit)
    await exec.exec(
      `git --git-dir ${repoDir}/.git --work-tree ${repoDir} fetch -v --prune --no-recurse-submodules origin ${fetchInfo.ref}`
    )

    // Checkout the ref
    const checkoutInfo = getCheckoutInfo(ref, commit)
    if (checkoutInfo.startPoint) {
      await exec.exec(
        `git --git-dir ${repoDir}/.git --work-tree ${repoDir} checkout --progress --force -B ${checkoutInfo.ref} ${checkoutInfo.startPoint}`
      )
    } else {
      await exec.exec(
        `git --git-dir ${repoDir}/.git --work-tree ${repoDir} checkout --progress --force ${checkoutInfo.ref}`
      )
    }

    if (config.persistCredentials) {
      // Persist authentication in local
      await configGitRepoLocalAuth(config.token, repoDir)
      // Set auth for submodules
      await configGitAuthForSubmodules(config.token, repoDir)
    }

    // Cleanup global authentication config
    await cleanupGitGlobalAuth()
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
  targetPath: string
  submodules: boolean
  nestedSubmodules: boolean
  dissociateMainRepo: boolean
  dissociateSubmodules: boolean
  persistCredentials: boolean
}

function parseInputConfig(): IInputConfig {
  const result = {} as unknown as IInputConfig

  const ownerRepo = core.getInput('repository') // owner/repository
  core.debug(`Repository ${ownerRepo}`)
  const splitRepo = ownerRepo.split('/')
  result.owner = splitRepo[0]
  result.repo = splitRepo[1]

  // Workflow repository?
  result.isWorkflowRepository =
    ownerRepo.toUpperCase() ===
    `${github.context.repo.owner}/${github.context.repo.repo}`.toUpperCase()

  result.ref = core.getInput('ref')
  result.commit = ''
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

  const persistCredentialsString = (
    core.getInput('persist-credentials') || ''
  ).toUpperCase()
  if (persistCredentialsString === 'TRUE') {
    result.persistCredentials = true
  } else {
    result.persistCredentials = false
  }
  core.debug(`persistCredentials = ${result.persistCredentials}`)

  return result
}

interface ICheckoutInfo {
  ref: string
  startPoint: string
}

function getCheckoutInfo(ref: string, commit: string): ICheckoutInfo {
  if (!ref && !commit) {
    throw new Error('Args ref and commit cannot both be empty')
  }

  const result = {} as unknown as ICheckoutInfo
  const upperRef = (ref || '').toUpperCase()

  // SHA only
  if (!ref) {
    result.ref = commit
  }
  // refs/heads/
  else if (upperRef.startsWith('REFS/HEADS/')) {
    const branch = ref.substring('refs/heads/'.length)
    result.ref = branch
    result.startPoint = `refs/remotes/origin/${branch}`
  }
  // refs/pull/
  else if (upperRef.startsWith('REFS/PULL/')) {
    const prNumber = ref.split('/')[2]
    if (prNumber) {
      result.ref = `refs/pull/${prNumber}/head`
    } else {
      result.ref = ref
    }
  }
  // refs/tags/
  else if (upperRef.startsWith('REFS/')) {
    result.ref = ref
  }

  return result
}

interface IFetchInfo {
  ref: string
}

function getFetchInfo(ref: string, commit: string): IFetchInfo {
  if (!ref && !commit) {
    throw new Error('Args ref and commit cannot both be empty')
  }

  const result = {} as unknown as ICheckoutInfo
  const upperRef = (ref || '').toUpperCase()

  // SHA only
  if (!ref) {
    result.ref = commit
  }
  // refs/heads/
  else if (upperRef.startsWith('REFS/HEADS/')) {
    const branch = ref.substring('refs/heads/'.length)
    if (commit) {
      result.ref = `+${commit}:refs/remotes/origin/${branch}`
    } else {
      result.ref = `${branch}`
    }
  }
  // refs/pull/
  else if (upperRef.startsWith('REFS/PULL/')) {
    const prNumber = ref.split('/')[2]
    if (prNumber) {
      result.ref = `+${commit}:refs/pull/${prNumber}/head`
    } else {
      result.ref = ref
    }
  }
  // refs/tags/
  else if (upperRef.startsWith('REFS/')) {
    result.ref = ref
  }
  // Unqualified ref, check for a matching branch or tag
  else if (!upperRef.startsWith('REFS/')) {
    result.ref = [
      `+refs/heads/${ref}*:refs/remotes/origin/${ref}*`,
      `+refs/tags/${ref}*:refs/tags/${ref}*`
    ].join(' ')
  }

  return result
}

async function configGitAuthForSubmodules(token: string, repoDir: string) {
  // Set authentication
  const basicCredential = Buffer.from(
    `x-access-token:${token}`,
    'utf8'
  ).toString('base64')
  core.setSecret(basicCredential)

  await exec.exec(
    `git submodule foreach --recursive sh -c "git config --local --add 'http.https://github.com/.extraheader' 'AUTHORIZATION: basic ${basicCredential}'"`,
    [],
    { cwd: repoDir ? repoDir : undefined }
  )
  await exec.exec(
    `git submodule foreach --recursive sh -c "git config --local --add 'url.https://github.com/.insteadOf' 'git@github.com:'"`,
    [],
    { cwd: repoDir ? repoDir : undefined }
  )
}

async function configGitGlobalAuth(token: string) {
  configGitAuthImpl(token, true, '')
}

async function configGitRepoLocalAuth(token: string, repoDir: string) {
  configGitAuthImpl(token, false, repoDir)
}

async function configGitAuthImpl(
  token: string,
  global: boolean,
  repoDir: string
) {
  // Set authentication
  const basicCredential = Buffer.from(
    `x-access-token:${token}`,
    'utf8'
  ).toString('base64')
  core.setSecret(basicCredential)

  var configSelector = '--local'
  if (global) {
    configSelector = '--global'
  }

  // (NSL-2981) Remove previous extra auth header if any
  await exec.exec(
    `git config ${configSelector} --unset-all http.https://github.com/.extraheader`,
    [],
    { ignoreReturnCode: true, cwd: repoDir ? repoDir : undefined }
  )
  await exec.exec(
    `git config ${configSelector} --add http.https://github.com/.extraheader "AUTHORIZATION: basic ${basicCredential}"`,
    [],
    { cwd: repoDir ? repoDir : undefined }
  )
  await exec.exec(
    `git config ${configSelector} --add url.https://github.com/.insteadOf git@github.com:`,
    [],
    { cwd: repoDir ? repoDir : undefined }
  )
}

async function cleanupGitGlobalAuth() {
  cleanupGitAuthImpl(true)
}

async function cleanupGitAuthImpl(global: boolean) {
  var configSelector = '--local'
  if (global) {
    configSelector = '--global'
  }

  await exec.exec(
    `git config ${configSelector} --unset-all http.https://github.com/.extraheader`,
    [],
    { ignoreReturnCode: true }
  )
  await exec.exec(
    `git config ${configSelector} --unset-all url.https://github.com/.insteadOf`,
    [],
    { ignoreReturnCode: true }
  )
}

async function gitClone(
  owner: string,
  repo: string,
  repoDir: string,
  flags: string[]
) {
  const flagString = flags.join(' ')
  await exec.exec(
    `git clone ${flagString} -- https://token@github.com/${owner}/${repo}.git ${repoDir}`
  )
}

async function gitFetch(gitDir: string) {
  await exec.exec(
    `git -c protocol.version=2 --git-dir ${gitDir} fetch --no-recurse-submodules origin`
  )
}

async function gitSubmoduleUpdate(
  config: IInputConfig,
  mirrorDir: string,
  repoDir: string
) {
  const recursiveFlag = config.nestedSubmodules ? '--recurse' : ''
  const fetchDepthFlag = getFetchDepthFlag(config)
  const dissociateFlag = config.dissociateSubmodules ? '--dissociate' : ''
  const debugFlag = core.isDebug() ? '--debug_to_console' : ''
  await exec.exec(
    `nsc git-checkout update-submodules --mirror_base_path "${mirrorDir}" --repository_path "${repoDir}" ${recursiveFlag} ${fetchDepthFlag} ${dissociateFlag} ${debugFlag}`
  )
}

// Returns the --depth <depth> flag or an empty string if the full history should be fetched.
function getFetchDepthFlag(config: IInputConfig) {
  return config.fetchDepth <= 0 ? '' : `--depth=${config.fetchDepth}`
}
