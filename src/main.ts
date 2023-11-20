import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'

export async function run(): Promise<void> {
  try {
    const config = await parseInputConfig()

    const gitMirrorPath = process.env['NSC_GIT_MIRROR']
    core.debug(`Git mirror path ${gitMirrorPath}`)
    if (!gitMirrorPath || !fs.existsSync(gitMirrorPath)) {
      throw new Error(`Experimental git mirror feature must be enabled.`)
    }

    const workspacePath = process.env['GITHUB_WORKSPACE']
    core.debug(`Workspace path ${workspacePath}`)
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error(
        `GitHub Runner workspace is not set GITHUB_WORKSPACE = ${workspacePath}.`
      )
    }

    // Set authentication
    const basicCredential = Buffer.from(
      `x-access-token:${config.token}`,
      'utf8'
    ).toString('base64')

    await exec.exec(
      `git config --global --add http.https://github.com/.extraheader "AUTHORIZATION: basic ${basicCredential}"`
    )

    // Prepare mirror if does not exist
    // v1/ path was introduced with v1 tag because the way we cloned the mirror in v0 was not
    // compatible with caching submodules, so we had to change the mirror repo directory to force a re-clone
    const mirrorDir = path.join(
      gitMirrorPath,
      `v1/${config.owner}-${config.repo}`
    )
    if (!fs.existsSync(mirrorDir)) {
      fs.mkdirSync(mirrorDir, { recursive: true })
      await exec.exec(
        `git clone -- https://token@github.com/${config.owner}/${config.repo}.git ${mirrorDir}`
      )
    }

    const fetchDepthFlag =
      config.fetchDepth <= 0 ? '' : `--depth=${config.fetchDepth}`
    // Clone submodules
    if (config.submodules) {
      const recursiveFlag = config.nestedSubmodules ? '--recursive' : ''
      await exec.exec(`git submodule sync ${recursiveFlag}`, [], {
        cwd: mirrorDir
      })
      await exec.exec(
        `git -c protocol.version=2 submodule update --init ${recursiveFlag} --jobs=8 --force ${fetchDepthFlag}`,
        [],
        { cwd: mirrorDir }
      )
    }

    // Fetch commits for mirror
    const fetchSubmodules = config.submodules
      ? `--multiple --jobs=8 --recurse-submodules`
      : ''
    await exec.exec(
      `git -c protocol.version=2 --git-dir ${mirrorDir}/.git fetch ${fetchSubmodules} origin`
    )

    // Prepare repo dir
    let repoDir = workspacePath
    if (config.targetPath) {
      repoDir = path.join(workspacePath, config.targetPath)
    }

    // Clone the repo
    const submodulesFlag = config.submodules
      ? `--recurse-submodules --jobs=8`
      : ''
    await exec.exec(`git config --global --add safe.directory ${repoDir}`)
    await exec.exec(
      `git clone --reference-if-able ${mirrorDir} ${submodulesFlag} ${fetchDepthFlag} -- https://token@github.com/${config.owner}/${config.repo}.git ${repoDir}`
    )

    // When ref is unspecified and for repositories different from the one where the workflow is running
    // resolve their default branch and use it as `ref`
    let ref = config.ref
    let commit = config.commit
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
    const fetchInfo = await getFetchInfo(ref, commit)
    await exec.exec(
      `git --git-dir ${repoDir}/.git --work-tree ${repoDir} fetch -v --prune --no-recurse-submodules origin ${fetchInfo.ref}`
    )

    // Checkout the ref
    const checkoutInfo = await getCheckoutInfo(ref, commit)
    if (checkoutInfo.startPoint) {
      await exec.exec(
        `git --git-dir ${repoDir}/.git --work-tree ${repoDir} checkout --progress --force -B ${checkoutInfo.ref} ${checkoutInfo.startPoint}`
      )
    } else {
      await exec.exec(
        `git --git-dir ${repoDir}/.git --work-tree ${repoDir} checkout --progress --force ${commit}`
      )
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

export interface IInputConfig {
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
}

export async function parseInputConfig(): Promise<IInputConfig> {
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
  if (submodulesString == 'RECURSIVE') {
    result.submodules = true
    result.nestedSubmodules = true
  } else if (submodulesString == 'TRUE') {
    result.submodules = true
  }
  core.debug(`submodules = ${result.submodules}`)
  core.debug(`recursive submodules = ${result.nestedSubmodules}`)

  return result
}

export interface ICheckoutInfo {
  ref: string
  startPoint: string
}

export async function getCheckoutInfo(
  ref: string,
  commit: string
): Promise<ICheckoutInfo> {
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

export interface IFetchInfo {
  ref: string
}

export async function getFetchInfo(
  ref: string,
  commit: string
): Promise<IFetchInfo> {
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

  return result
}
