# Publishing `duckwc` to npm

Use this guide to release the public package in `packages/core`.

## Before publishing

Work from a clean `main` branch. Choose an unused SemVer version in
`packages/core/package.json`; use a minor version for breaking API changes and
a patch version for backwards-compatible fixes. Do not reuse a published npm
version.

Run the release checks from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter duckwc test
pnpm build
cd packages/core && npm pack --dry-run
```

The dry run must contain only `README.md`, `package.json`, and the built
`dist/` files.

## Publish

Log in with an npm account that can publish `duckwc`. If the account requires
two-factor authentication, enter the current code from its authenticator app
locally; never share tokens or one-time codes in chat.

```bash
cd packages/core
npm publish --access public --otp=YOUR_2FA_CODE
npm publish --//registry.npmjs.org/:_authToken=YOUR_TOKEN
npm view duckwc name version dist-tags --json
```

Commit the version and source changes, then push `main`. For future releases,
repeat the version bump and checks before publishing.

## Publish the GitHub Packages mirror

The npmjs package remains `duckwc`. GitHub Packages requires a scoped name, so
this repository publishes the same built files separately as
`@duyduc-dev/duckwc`. Do not rename `packages/core` to the scoped name: that
would break existing npmjs consumers.

After the npmjs release is published and pushed, open **Actions → Publish
GitHub Package → Run workflow** on the matching commit. The workflow runs the
core test/build checks and publishes with its repository-scoped `GITHUB_TOKEN`.
It is manual-only and never publishes on an ordinary push. GitHub will link
the package to this repository through the package manifest's `repository`
field.

For a local dry run of the generated scoped artifact:

```bash
pnpm --filter duckwc build
pnpm --filter duckwc publish:github -- --dry-run
```

Consumers configure the GitHub npm registry for this scope before installing:

```ini
@duyduc-dev:registry=https://npm.pkg.github.com
```

GitHub Packages requires authentication to install packages as well. Add a
classic personal access token with `read:packages` to the consumer's **user**
`~/.npmrc`; never commit it to the project:

```ini
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_CLASSIC_PAT
```

```bash
npm install @duyduc-dev/duckwc
```
