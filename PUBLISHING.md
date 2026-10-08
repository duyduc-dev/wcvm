# Publishing `wcvm` to npm

The public package is `packages/core` (name `wcvm`). Only the built `dist/`, `README.md`, `LICENSE`
and the third-party notices are published.

## Publishing from GitHub Actions

`.github/workflows/publish-packages.yml` publishes when you push a release tag, so nobody needs a local npm login:

| Tag | Publishes | Checks it runs first |
|---|---|---|
| `v<version>` (e.g. `v0.3.3`) | `wcvm` (`packages/core`) | `tsc`, Vitest, build, the Playwright suite in real Chromium |
| `sdk-v<version>` (e.g. `sdk-v0.1.2`) | `@wcvm/sdk` (`packages/sdk`) | `tsc`, build |

Steps:

1. Bump `version` in the package's `package.json`, commit, push `main`.
2. `git tag v0.3.3 && git push origin v0.3.3` (or `sdk-v0.1.2`).

The run stops before publishing if the tag differs from `package.json`'s version, and does nothing if that version is already on npm.
It publishes under the **`next`** dist-tag with a provenance statement; promote it yourself once you are happy:
`npm dist-tag add wcvm@<version> latest`.

One-time setup: add a repository secret **`NPM_TOKEN`** (Settings -> Secrets and variables -> Actions -> Repository secrets): an npm
*Automation* token, or a granular token with read/write on `wcvm` and `@wcvm/sdk`, so no one-time code is requested. If you would rather
not store a token, npm's "trusted publishing" (npmjs.com -> package -> Settings -> Trusted Publisher -> this repo and
`publish-packages.yml`) works with this workflow too; then drop `NODE_AUTH_TOKEN` from the publish step.

For `@wcvm/sdk`, deploy Studio first if the wire protocol changed (see below). The manual steps in the rest of this file still work.

## Before publishing

Work from a clean, pushed `main`. Pick an unused SemVer version in `packages/core/package.json`
(while the version is `0.x`, a minor bump may break the API). Never reuse a published version.

Run the checks (Node 24; the Vitest suite needs `URLPattern`/`CloseEvent`):

```bash
pnpm install --frozen-lockfile
cd packages/core
npx tsc --noEmit -p .
npx vitest run
pnpm build
cd ../../examples/playground && pnpm exec playwright test      # real Chromium; add WCVM_E2E_VITE=1 for the real-registry tests
```

Then check what would be published:

```bash
cd packages/core && npm pack --dry-run
```

It must list `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.node.txt`,
`package.json` and the files under `dist/` - nothing else (no `src/`, no tests).

## Publish

Log in with an npm account that may publish `wcvm`. If it has two-factor authentication, type the
current code locally; never paste tokens or one-time codes into chat or commit them.

```bash
cd packages/core
npm publish --access public --tag next --otp=<code>      # first releases: "next", not "latest"
npm dist-tag add wcvm@<version> latest                   # once you are happy with it
npm view wcvm name version dist-tags --json
```

Then commit the version bump and push `main`, and tag the release (`git tag v<version>`).

## When the vendored Node changes

`packages/core/src/runtime/node/lib/**` is Node's own source and is generated, never edited:
`node scripts/vendor-node-lib.mjs`. If the vendored Node version changes, replace
`packages/core/THIRD_PARTY_LICENSES.node.txt` with that version's `LICENSE`
(`https://github.com/nodejs/node/blob/<version>/LICENSE`) and update the version in
`THIRD_PARTY_NOTICES.md`.

## Publishing `@wcvm/sdk`

`packages/sdk` is the host-page SDK for the embeddable editor (`embed()`); it talks to Studio's `/embed` page over `postMessage`.
It lives under the `@wcvm` npm organization and ships only `dist/`, `src/protocol.ts`, `README.md` and `LICENSE`.

Deploy Studio first (`bash scripts/deploy-sites.sh studio`): the SDK's default URL is `https://studio.wcvmjs.com/embed`, and
`curl -sI <that url>` must show `Cross-Origin-Resource-Policy: cross-origin`. Then:

```bash
cd packages/sdk
npx tsc --noEmit -p . && pnpm build
npm pack --dry-run                              # LICENSE, README.md, package.json, dist/*, src/protocol.ts
npm publish --tag next --otp=<code>             # access is public via publishConfig
npm dist-tag add @wcvm/sdk@<version> latest     # once you are happy with it
```

If the wire protocol (`src/protocol.ts`) changes incompatibly, bump the SDK's version and keep Studio's `/embed` accepting the old one
for a while: host pages pin the SDK, but always load the current Studio.
