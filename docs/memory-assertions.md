# Explicit memory assertions

Structured assertions describe what a reviewer explicitly declared. They do not
prove the statement is true, verify the reviewer's identity, extract facts from
free text, or authorize acceptance/publication.

Create a private proposal that cites its evidence, then attach a reviewed JSON
file:

```sh
graph-engine memory-add "Use PostgreSQL for production storage." --kind constraint \
  --source docs/adr/0012-database.md#L5-L18
graph-engine memory-assertions <memory-id> reviewed-assertions.json
graph-engine memory-accept <memory-id>
graph-engine memory-share <memory-id>
graph-engine memory-export-authorize <memory-id>                  # prints the exact text and its SHA-256
graph-engine memory-export-authorize <memory-id> --sha256 <hash>  # records consent
```

Attachment is only allowed while a record is `proposed`; acceptance, sharing and
export authorization are separate, explicit operations. `--source
<path>#L<start>-L<end>` (or `#L<line>`; repeat it for more sources) cites lines
of a file in a fresh index snapshot of the working tree, which records the
file's content hash. A file that does not exist, a file the index leaves out
(excluded, ignored by Git, outside the working set, binary, over 1 MiB or
matching a credential pattern) and lines past the end of the file are refused.
A final newline ends the last line rather than starting another, so a file of
two lines that ends in a newline can be cited at lines 1-2 only, and an empty
file has no lines to cite.

Sharing does not release a memory to cloud consumers. A requirement or
constraint reaches a cloud client or worker only when it cites source evidence
inside `exportPaths`, is shared, and an operator has authorized its exact text:
`graph-engine memory-export-authorize <memory-id>` shows the text and its SHA-256, and
re-running with `--sha256 <hash>` records that consent;
`graph-engine memory-export-revoke <memory-id>` withdraws it. Until then cloud
`context_get` and cloud worker turns refuse the whole packet, naming each
blocked memory and the command that unblocks it. Only the operator's command
line records consent; no MCP tool or dashboard route can. `memory-add` warns
when a new requirement or constraint in a project that allows cloud inference
cites no source, or a source outside `exportPaths`, since it could not be
authorized.

To revise accepted knowledge, or to replace a requirement or constraint that
cites no exportable evidence, propose a successor with `--supersedes <old-id>`:

```sh
graph-engine memory-add "Use PostgreSQL 16 for production storage." --kind constraint \
  --source docs/adr/0014-database.md#L3-L9 --supersedes <old-id>
graph-engine memory-accept <new-id>   # retires <old-id>: its status becomes superseded
```

Accepting the successor retires the old memory, which keeps its history but
leaves every context packet. Only an accepted memory can be superseded, so a
`conflicted` one cannot. An assertion review's timestamp must not predate its
proposal. The authenticated local API equivalent is `POST /api/memories` with
`{ text, kind, sources?: [{ path, startLine, endLine }], supersedes? }` (the
server resolves each source's content hash and snapshot itself), then `POST /api/memories/:id/assertions` with the JSON document
as its body, followed separately by `/accept` and, if intended, `/promote`.

```json
{
  "version": "1.0.0",
  "claims": [
    {
      "subject": "application.database",
      "predicate": "engine",
      "scope": { "environment": "production" },
      "value": { "type": "string", "value": "postgresql" },
      "exclusive": true
    }
  ],
  "review": {
    "reviewer": "project-partner",
    "reviewedAt": "2026-09-22T12:00:00.000Z",
    "evidence": ["Reviewed ADR-12 and its source references"]
  }
}
```

Use the actual review time and evidence. Optional `validFrom`/`validUntil` on a
claim are ISO timestamps defining a half-open interval `[from, until)`; omitted
endpoints are unbounded. Scope is required: `{}` is explicitly global and is not
equivalent to a named environment. Subject/predicate/scope strings are exact and
case-sensitive. Equivalent aliases must be mapped to the same canonical values
by the reviewer; the engine does not guess synonyms.

Values support `string`, finite `number`, `boolean`, and `string-set`.
Strings, numbers, and booleans remain different types; set ordering and duplicate
set elements do not change meaning. Claim order, scope-key order, evidence order,
and equivalent timestamp offsets are normalized without mutating the input.

An `exact-contradiction` means two reviewed claims declare different typed values
for the same exact subject/predicate/scope, overlapping validity, and both declare
`exclusive: true`. Nonexclusive alternatives do not imply a contradiction;
inconsistent exclusivity declarations get a separate semantics flag. Free-text
`possible-contradiction` flags remain lexical heuristics. Neither flag selects a
winner or removes required constraints.

Malformed/cyclic/dangling/competing or backward-time supersession requires review.
Explicit acceptance rejects invalid links; shared import keeps required
predecessors active instead of applying invalid transitions. Valid imported
chains are processed atomically independent of filename order. Concurrent memory
changes abort compare-and-swap updates and require reloading/reviewing. Sharing
also writes a repository file, so inspect that file if a concurrent-update error
occurs during sharing.

Metadata must be plain JSON, at most 64 KB, with 1–32 claims and 1–32 evidence
entries. Identifiers and scope values are at most 240 characters; scope has at
most 16 dimensions. String values/evidence entries are at most 4,000 characters;
sets contain at most 64 strings of at most 1,000 characters. Prototype keys,
accessors, sparse arrays, non-finite values, unsupported fields, and detected
credential patterns are rejected. Credential screening is not a guarantee that
arbitrary sensitive information will be recognized. Existing memories without
assertion metadata remain supported.

## Memory expiry

A memory can expire. Give it an expiry, an ISO 8601 date-time with a time zone,
when you propose or accept it:

```sh
graph-engine memory-add "Freeze the release branch." --kind constraint \
  --valid-until 2026-12-31T23:59:59Z
graph-engine memory-accept <memory-id> --valid-until 2027-01-15T00:00:00Z  # optional: set or replace it
graph-engine memory-review --within-days 30
```

The expiry is stored in UTC as the memory's `validUntil`. A memory is expired
from the instant its own `validUntil` passes or, when every reviewed claim has a
`validUntil`, the latest of those passes, whichever comes first; a claim without
one keeps the memory open-ended. An expired memory stays on record with its
status, but `context` and `context_get` leave it out of the mandatory section and
the retrieved items, and a local packet's warnings name it by ID only. Cloud
packets keep their fixed warnings, so expiry removes a memory from them and adds
nothing; export authorization still binds the exact text of every memory that
remains. An expired requirement or constraint that was never authorized stops
refusing cloud packets. A run already in progress keeps the mandatory memory it
started with.

An expiry already in the past is refused, and so is accepting a proposal whose
expiry has passed unless `--valid-until` gives a later one. The MCP
`memory_propose` tool takes an optional `validUntil`, but only a person accepts
the proposal. Once a memory is accepted its expiry is fixed: to renew or shorten
it, propose a successor with `memory-add --supersedes <id> --valid-until <iso>`.
A shared file under `.graph/knowledge/` that changes a memory's expiry marks the
memory conflicted, as any other edit does. `memory-review` flags each accepted
or conflicted memory that has `expired`, or is `expiring` within the window
(14 days unless `--within-days` says otherwise), with its ID and the date only.
Memories recorded before expiry existed have no `validUntil` and never expire;
the field lives in the stored memory record, so no database migration is needed.
