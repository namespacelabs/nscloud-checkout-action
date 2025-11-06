# Namespace optimized Checkout Action

This action is a specialized and optimized version of [`actions/checkout`](https://github.com/actions/checkout) for Namespace Runners.
It expects to run in a Namespace Runner and it will fail for otherwise. It also expects that the _git mirror_ feature is enabled in
the Namespace runner.

This action uses [Namespace Cache Volumes](https://namespace.so/docs/concepts/storage) to store a mirror of your git repository, and uses it speed up the checkout process.

## Usage

Both Namespace Cache Volume and Git mirror must be enabled. Note the `-with-cache` suffix and `nscloud-git-mirror-5gb` below.

```yaml
runs-on: [nscloud-ubuntu-22.04-amd64-2x4-with-cache, nscloud-git-mirror-5gb]
steps:
  - name: Checkout
    uses: namespacelabs/nscloud-checkout-action@v8
```

### Supported input fields

```yaml
runs-on: [nscloud-ubuntu-22.04-amd64-2x4-with-cache, nscloud-git-mirror-5gb]
steps:
  - name: Checkout
    uses: namespacelabs/nscloud-checkout-action@v8
    with:
      # Repository name with owner. For example, actions/checkout
      # Default: ${{ github.repository }}
      repository: ''

      # The branch, tag or SHA to checkout. When checking out the repository that
      # triggered a workflow, this defaults to the reference or SHA for that event.
      # Otherwise, uses the default branch.
      ref: ''

      # Personal access token (PAT) used to fetch the repository. The PAT is configured
      # with the local git config, which enables your scripts to run authenticated git
      # commands. The post-job step removes the PAT.
      #
      # We recommend using a service account with the least permissions necessary. Also
      # when generating a new PAT, select the least scopes necessary.
      #
      # [Learn more about creating and using encrypted secrets](https://help.github.com/en/actions/automating-your-workflow-with-github-actions/creating-and-using-encrypted-secrets)
      #
      # Default: ${{ github.token }}
      token: ''

      # Number of commits to fetch. 0 indicates all history for all branches and tags.
      # Default: 1
      fetch-depth: ''

      # Relative path under $GITHUB_WORKSPACE to place the repository
      path: ''

      # Whether to checkout submodules: `true` to checkout submodules or `recursive` to
      # recursively checkout submodules.
      #
      # SSH URLs beginning with `git@github.com:` are converted to HTTPS.
      #
      # Default: false
      submodules: ''
      
      # Dissociate the checkout (and optionally submodules, if any) from the mirror:
      # `true` to dissociate the main repository or 'recursive' to dissociate the main
      # repository and all submodules.
      # Dissociate instructs git to copy all git objects to a checkout directory. After
      # this, the checkout has no link to the Namespace Git mirror.
      # This allows docker-based GitHub actions to perform git operations on the checkout,
      # such as git status.
      #
      # Default: false
      dissociate: ''

      # Whether to configure the token or SSH key with the local git config
      # Default: true
      persist-credentials: ''

      # Whether to download and cache Git-LFS files
      # Default: false
      lfs: ''
```

## Development

1. Write your changes.
2. Bundle the JS app with `npm run bundle`
3. Git add all your changes and the auto-generated JS code
4. Git tag your last commit with `git tag v0`
5. Push to repo: `git pull && git push`
