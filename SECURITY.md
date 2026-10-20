# Security policy

## Supported versions

Agile Graph is at 0.x. Only the latest minor release of 0.x gets security
fixes. Older 0.x releases do not.

For versioning policy, deprecations, and Node.js range, see
[publishing](docs/publishing.md#versioning-and-support).

| Version    | Supported |
| ---------- | --------- |
| Latest 0.x | Yes       |
| Older 0.x  | No        |

Fixes ship as a new patch release of the latest minor. To get a fix, upgrade.

## Supported Node.js versions

The supported Node.js range is `^22.18.0 || >=24 <27` (Node.js 22.18 or later on
22, or 24 to 26), which the published packages
(`@agile-graph/engine` and `@agile-graph/contracts`) declare in their `engines`
field. Other Node.js versions get no support.

## Report a vulnerability

Report privately. Never open a public issue or pull request for a
vulnerability.

1. Open the repository on GitHub: https://github.com/MILTONADINA/agile-graph
2. Go to the Security tab.
3. Choose "Report a vulnerability" and fill in the form.

Include the affected package and version, the steps to reproduce, and the
impact. Use synthetic data only. Do not send secrets, keys or data from
your own projects.

## What to expect

- We aim to acknowledge a report within 5 working days.
- We confirm the issue, or tell you why we do not, and keep you updated in
  the private report.
- We prepare the fix in a private advisory branch, release it, then publish
  a GitHub security advisory. The advisory credits you unless you ask us not
  to.
- Please keep the details private until the advisory is published.

## Scope

In scope:

- `@agile-graph/engine`
- `@agile-graph/contracts`
- `@agile-graph/dashboard` (not published to npm; it lives in this
  repository)

Out of scope:

- Third-party models and services you connect to the engine.
- Your own projects and their code.
- Vulnerabilities in dependencies with no effect on these packages. Report
  those to the dependency's maintainers.

## Releases and provenance

Releases are published to npm from CI. Version 0.1.0 of the engine and
contracts packages was the first publish, made from a developer machine: it has
registry signatures but no provenance attestation. Later releases published
from CI carry npm provenance, which links the package to the commit and
workflow that built it. See [publishing](docs/publishing.md).

To verify the packages you installed, run this in your project:

```
npm audit signatures
```

It checks the registry signatures of your installed packages, and the
provenance attestations of those that have one.
