# Retro round 009: dashboard toolchain, tag protection docs, DevOPs 0.7.0

- Date: 2026-11-08
- Change this round: implementation went to Haiku workers through Hermes,
  with a Sonnet review before merge. The orchestrating session only
  reviewed, ran the tests and merged.

## Where the numbers come from

- **Repository delivery:** pull requests merged on 2026-11-07 and 2026-11-08
  after the round 008 retro (`git log origin/main` here, and `origin/dev`
  and `origin/main` in DevOPs).
- **Spend:** `hermes insights --days 1` estimated about $2.70 for the
  round's worker and review calls. That estimate runs high, and the owner
  checks the Console balance.

## What shipped

| Merge       | Stories                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| #352        | `docs/publishing.md` says how to protect the release tags (closes #292)                   |
| #353        | dashboard on `vite` 8 and `@vitejs/plugin-react` 6, with a fresh offline lockfile receipt |
| DevOPs #407 | install manifest: refuse a symlinked original copy, save each record as it happens        |
| DevOPs #408 | DevOPs release 0.7.0, merged to `main` and waiting for the owner's signed tag             |
| DevOPs #412 | `main` synced back into `dev`                                                             |

## What review by a second model found

- An automated review of the first 0.7.0 release pull request (DevOPs
  #406) found two real defects:
  - An original copy was read through a symlinked folder.
  - Install records were lost when a signal stopped `devops init` during
    signature checks.
    The release was closed, and both were fixed first.
- The Sonnet review of the fix found one more data-loss path. An
  original copy cut short by a signal would later pass uninstall's hash
  check and be restored over the user's file. Copies and the manifest are
  now written to a temp file, flushed, and renamed or linked into place.
  Uninstall removes leftover temp files.

## What was slow

- **Signed tags need the owner's key.** The release tag is signed with the
  owner's SSH key, so the session stopped at the tag and handed over the
  command.
- **A squash release conflicts on the sync back to `dev`.** The plain
  `main` → `dev` pull request (#409) conflicted in `CHANGELOG.md`. It was
  replaced by a branch off `dev` that merges `main` and takes `main`'s
  changelog and upgrade guide.

## Hypotheses for the next rounds

1. **Review the release candidate before opening the release pull request
   (new).** Both #406 findings were in code already merged to `dev`. Next
   change: run the second-model review on the `dev` → `main` diff before
   the release branch is cut.
2. **Every state file is replaced whole (new).** A record written in place
   can be cut short by a signal. Next change: write new state files through
   a temp-and-rename helper, with a test that interrupts the write.
3. **Read every major release note against the workflows that use it
   (round 008): confirmed.** The dashboard toolchain majors merged on the
   first CI run.

## Deferred

- DevOPs #413: uninstall leaves the `.mcp.json` entry and the Agile Graph
  pin file.
- `@connectrpc/connect-node` 2 (#197), which needs its own lockfile receipt.
- The npm environment's self-approval setting (#289), an owner decision.
