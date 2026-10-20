# Publishing to npm

Agile Graph ships as two public npm packages:

| Package                  | What it is                                                  |
| ------------------------ | ----------------------------------------------------------- |
| `@agile-graph/contracts` | The shared project, context, execution and decision schemas |
| `@agile-graph/engine`    | The `graph-engine` command, its MCP server and dashboard    |

The dashboard is built into the engine package; `@agile-graph/dashboard`
stays private. Both packages carry the repository's MIT license, and the
engine also carries the [`NOTICE`](../NOTICE) for its vendored files.

Publishing is the owner's step. No agent publishes, and nothing in CI
publishes except the release workflow below, which waits for the owner's
approval.

## What a release checks

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs when a
tag such as `v0.1.0` is pushed. It:

1. refuses a tag whose commit is not on `main`, so only reviewed, green work is
   released, whoever pushed the tag;
2. waits for an approval on the `npm` environment;
3. builds everything, then checks that the tag matches both package versions,
   the package metadata and the exact files each tarball contains
   (`scripts/npm-packages.test.mjs`);
4. installs both packed tarballs into an empty directory and runs the CLI
   (`scripts/npm-smoke.mjs`);
5. generates a CycloneDX SBOM for each package with `npm sbom
--sbom-format cyclonedx --omit dev` (runtime dependencies only) and uploads
   `contracts.cdx.json` and `engine.cdx.json` as the workflow artifact
   `sbom-<tag>`, next to the provenance npm records;
6. publishes the contracts package, then the engine, skipping a version that
   is already on npm.

`scripts/sbom.test.mjs` runs the same `npm sbom` command locally and checks
that each output is valid CycloneDX JSON listing the package at its version.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers):
GitHub's OpenID Connect token authenticates the job, so no npm token is
stored anywhere, and npm records signed provenance for each package. The
workflow needs npm 11.5.1 or later, which it installs.

## One-time setup

1. **Create the npm organization.** Sign in to npmjs.com and create the free
   organization `agile-graph`, which owns the `@agile-graph` scope. Enable
   two-factor authentication on your npm account.
2. **Protect the release environment.** In the GitHub repository, open
   Settings → Environments → `npm` and add yourself as a required reviewer,
   so every publish waits for your approval.
3. **Publish the first version once from your machine.** npm configures
   trusted publishing on an existing package, so the very first publish is
   manual:

   ```sh
   git switch main && git pull --ff-only origin main
   npm ci
   npm run build
   node --test scripts/npm-packages.test.mjs
   node scripts/npm-smoke.mjs
   npm login
   npm publish --workspace packages/contracts --access public
   npm publish --workspace packages/engine --access public
   ```

4. **Connect each package to the workflow.** `npm trust` needs npm 11.15.0 or
   later, so check `npm --version` first and upgrade with
   `npm install -g npm@11` if it is older. Run these in your own terminal,
   because npm asks you to confirm each one with two-factor authentication:

   ```sh
   npm trust github @agile-graph/contracts --file release.yml --repository MILTONADINA/agile-graph --environment npm --allow-publish
   npm trust github @agile-graph/engine --file release.yml --repository MILTONADINA/agile-graph --environment npm --allow-publish
   ```

   The same settings can be entered on npmjs.com under each package's
   settings → Trusted Publisher → GitHub Actions. A new trusted publisher must
   complete a publish within two days, or it has to be created again.

5. **Optionally require trusted publishing.** In each package's settings,
   choose to disallow token publishing, so only the workflow can publish.

## Releasing a new version

1. On a feature branch, set the same new version in
   `packages/contracts/package.json`, `packages/engine/package.json` and
   `packages/dashboard/package.json`, and the engine's and dashboard's
   dependency on `@agile-graph/contracts` to that exact version. Otherwise npm
   resolves the old contracts version from the registry instead of the
   workspace. Run `npm install --package-lock-only` and commit the lockfile.
2. Merge the PR into `main` through the usual checks.
3. Tag the merged commit and push the tag:

   ```sh
   git switch main && git pull --ff-only origin main
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. Approve the `npm` deployment when GitHub asks.

The release fails, and nothing is published, if the tag and the package
versions differ, a tarball would contain anything outside its allowlist, or
the installed CLI does not start.

## What the packages contain

Each tarball is limited by its `files` list:

- **contracts:** compiled JavaScript and type declarations, `README.md`,
  `LICENSE`.
- **engine:** compiled JavaScript and type declarations, the dashboard's
  built files, the security scanner's Dockerfile, the Dart analyzer's seccomp
  profile, the vendored Cloudflare audit files with their license,
  `README.md`, `LICENSE` and `NOTICE`.

Sources, tests, fixtures, benchmarks and source maps are not published.
Because an installed package has no `src/` directory, the stale-build check
that guards a source checkout does not apply; the release builds from a clean
`dist/` instead.

Two heavy integrations are optional peer dependencies, installed only by a
user who wants them: `@huggingface/transformers` for local embeddings and
`@cursor/sdk` for Cursor workers. See the [engine package
README](../packages/engine/README.md).
