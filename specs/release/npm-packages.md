# Publishing the engine and contracts to npm

- ID: npm-packages
- Status: implemented
- Area: release

## Problem

People should be able to install Agile Graph with
`npm install --global @agile-graph/engine` and use it on their own
machine, without cloning the repository. What they install must contain only
the built engine and the files it needs at run time, carry the project's
license, and never reach outside its own package for code or files to load
or serve. Releases must be reproducible from reviewed work and traceable to
it.

## Acceptance criteria

- AC1: `@agile-graph/contracts` and `@agile-graph/engine` are
  public, MIT-licensed, require Node.js 24 to 26, name this repository (with
  the exact URL npm trusted publishing checks) and share one version, with the
  engine depending on exactly that contracts version. The dashboard and the
  workspace root stay private.
  - Test: scripts/npm-packages.test.mjs :: both packages are public, MIT-licensed and point at this repository
- AC2: Each package carries the repository's license file and the engine its
  notice, byte-for-byte.
  - Test: scripts/npm-packages.test.mjs :: each package carries the repository's license, and the engine its notice
- AC3: The contracts tarball holds only its compiled code, README and license.
  The engine tarball holds its compiled code, its build-source manifest, the
  built dashboard, the security scanner's Dockerfile, the Dart analyzer's
  seccomp profile, the vendored audit files and its README, license and
  notice, and never sources, tests, fixtures, source maps or the output of a
  deleted source.
  - Test: scripts/npm-packages.test.mjs :: the contracts tarball holds only its compiled code, README and license
  - Test: scripts/npm-packages.test.mjs :: the engine tarball holds its compiled code and runtime files, never sources or tests
- AC4: The local-embeddings library and the Cursor SDK are optional peer
  dependencies, not installed for everyone.
  - Test: scripts/npm-packages.test.mjs :: heavy integrations are optional peers, never installed for everyone
- AC5: An installed engine resolves no path outside its own package: it
  serves the dashboard packed into it, points the scanner image build at the
  Dockerfile it ships, and refuses the repository-only check of call-bound
  evidence. Only a checkout whose root package is this repository's resolves
  the repository's own dashboard build, scanner sidecar and evaluation
  harness.
  - Test: packages/engine/tests/package-layout.test.ts :: treats an installed engine as no checkout and keeps every file it serves inside the package
  - Test: packages/engine/tests/package-layout.test.ts :: accepts a checkout only when its root package is this repository's
  - Test: packages/engine/tests/package-layout.test.ts :: finds the repository it runs from as a source checkout
- AC6: A release publishes only a tagged commit that is on `main`, after the
  owner approves the `npm` environment, with npm trusted publishing rather
  than a stored token, and only when the tag names the packages' version.
  - Test: scripts/npm-packages.test.mjs :: the release workflow publishes only reviewed commits from main, without a stored token
  - Test: scripts/npm-packages.test.mjs :: a release tag names the packages' version

## Security considerations

The engine runs on users' machines with access to their repositories, and
its dashboard can drive its local API with the session token, so everything
it loads or serves must come from its own reviewed package: next to an
installed package, a relative path such as `../../..` reaches into whatever
else is installed. A source checkout is recognized only by the engine's
position inside it and the repository's own root package name. Publishing
uses OpenID Connect from GitHub Actions, so no npm token is stored, and npm
records provenance for each version. Anyone with write access can push a
tag, so the release refuses a commit that did not reach `main` through its
protected checks and waits for the owner's approval. The optional Cursor SDK
has a proprietary license and brings an HTTP client version with known
advisories, which the repository's own override cannot fix for installed
users; it is installed only by people who choose it.

## Non-goals

- Publishing the dashboard, the Laya sidecar, the evaluation harness or the
  verification images as packages.
- Running the release from an agent or from CI without the owner's approval.
- Supporting Node.js versions outside the engine's tested range.

## Design decisions

Asked with design text only on 2026-10-11 (Jev, with Laya as a second
opinion): Jev chose optional peer dependencies for the two heavy
integrations (0.94), refusing the repository-only command outside a source
checkout (0.80) and bundling the dashboard into the engine package (0.63).
Laya agreed on bundling the dashboard and leaned, with very low confidence,
towards optional dependencies and porting the command's helpers into the
package; Jev's choices were taken, as the safer ones for installed users.
