# Run provenance statement

- ID: run-provenance
- Status: implemented
- Area: quality

## Problem

Once a person accepts a run's result, other tools (a CI system, a release process, a later audit) need a standard, machine-readable record of what produced that result: the commit and files, the plan and policy it was bound to, the approval it used, the workers that ran and the gates it passed. The run receipt holds this, but in the engine's own shape and with free text that must stay local. An in-toto Statement v1 gives the same facts in a standard envelope with nothing private in it.

## Acceptance criteria

- AC1: For an accepted run, the engine builds an in-toto Statement v1 (`_type` `https://in-toto.io/Statement/v1`, `predicateType` `https://github.com/MILTONADINA/graph-engineering/provenance/run/v1`) whose subject is the result commit (`gitCommit`) and each changed file's sha256, and whose predicate holds the plan SHA-256, policy hash, decision mode, the approval used, the workers (provider ID, kind, model, pinned executable sha256), the gates with their snapshot hashes and timestamps; a strict schema refuses any other field.
  - Test: packages/engine/tests/run-provenance.test.ts :: emits a schema-valid in-toto Statement v1 for an accepted run
- AC2: The statement contains no prompt (objective or acceptance criteria), acceptance note, review summary, check output, secret, executable or model path, workspace path, pull request URL, endpoint, key variable name or user identity.
  - Test: packages/engine/tests/run-provenance.test.ts :: leaves prompts, notes, check output, secrets, paths and user identity out of the statement
- AC3: A run a person has not accepted (pending or rejected) gets no statement.
  - Test: packages/engine/tests/run-provenance.test.ts :: refuses a run a person has not accepted
- AC4: The decision mode is reported only while the project policy's hash still matches the plan's policy hash; otherwise it is null.
  - Test: packages/engine/tests/run-provenance.test.ts :: reports the decision mode only while the policy still matches the plan
- AC5: A run that published no commit is attested by its verified snapshot hash.
  - Test: packages/engine/tests/run-provenance.test.ts :: attests the verified snapshot when a run published no commit
- AC6: Changed-file digests are the sha256 of each file's exact bytes at the result commit, read from the repository's object store; removed files are listed in the predicate, not as subjects. A run with no recorded base commit is refused rather than diffed against a guess.
  - Test: packages/engine/tests/run-provenance.test.ts :: digests each changed file's bytes at the result commit
- AC7: Accepting a run writes its statement to `provenance/<runId>.intoto.json` in the project data directory; a failure to write is recorded as a `provenance.capture_failed` event and never reverts the acceptance. `graph-engine run-provenance <runId> [--out file]` builds the same statement read-only.
  - Test: packages/engine/tests/run-provenance.test.ts :: writes the statement when a person accepts a run that committed its result
- AC8: `graph-engine run-provenance` refuses a run still pending acceptance, and after `graph-engine accept` prints (or with `--out` writes) the same statement the acceptance wrote, reporting the plan approval the run used.
  - Test: packages/engine/tests/cli.test.ts :: refuses graph-engine run of a plan that does not publish until plan-approve --yes when the project requires plan approval, and the run records that non-interactive approval

## Security considerations

The statement is built from fields picked one by one, never from whole records: hashes, IDs, model names, timestamps and gate results. Free text from events (notes, summaries, check output) and plan text (objective, acceptance) are never read into it. A pinned executable is identified by its sha256 and version only, since its resolved path can name the person's home directory; a model given as a filesystem path is reduced to its base name. The pull request URL is left out because it names an account. The CLI command is local only and is not offered over MCP.

The statement is unsigned (`signed: false`). Signing it, for example with Sigstore, is a future option the owner decides on, and must never use the promotion keys. An unsigned statement is a record, not promotion evidence.

## Non-goals

- Signing or uploading the statement to a transparency log.
- SLSA build-level claims or a DSSE envelope.
- Statements for runs that were not accepted.
