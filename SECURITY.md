# Security policy

## Supported versions

Agile Graph is at 0.x. Only the latest minor release of 0.x gets security
fixes. Older 0.x releases do not.

| Version    | Supported |
| ---------- | --------- |
| Latest 0.x | Yes       |
| Older 0.x  | No        |

Fixes ship as a new patch release of the latest minor. To get a fix, upgrade.

## Supported Node.js versions

The `engines` field of each package sets the supported Node.js range:
`>=24 <27`. Other Node.js versions get no support.

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

Releases are published to npm from CI, not from a developer machine. Each
published package carries npm provenance, which links it to the commit and
workflow that built it. See [publishing](docs/publishing.md).

To verify the packages you installed, run this in your project:

```
npm audit signatures
```

It checks the registry signatures and the provenance attestations of your
installed packages.
