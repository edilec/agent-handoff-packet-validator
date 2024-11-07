# Packet rules

Every finding this tool emits carries one of these rule ids, and its severity
comes from the single frozen table in `src/index.mjs`. This document is the
catalog that table is checked against by `test/rule-catalog.test.mjs`, in both
directions: a rule missing from either side fails the suite.

The check between this table and the source is a consistency check, not the
guarantee. Severity is pinned behaviourally in `test/severity-outcomes.test.mjs`,
which drives a real packet through the real CLI for every rule below and asserts
the emitted severity word, the report status and the process exit code.

| Rule id | Severity | What it means |
| --- | --- | --- |
| `acceptance-empty` | error | The packet lists no acceptance criteria, so nobody can tell when the objective is met. |
| `acceptance-invalid` | error | An acceptance entry is not a non-empty string. |
| `acceptance-missing` | error | No `acceptance` array. An absent list is not an empty one. |
| `base-revision-invalid` | error | `baseRevision` is not a full 40-character lowercase hexadecimal object name. A branch moves; an abbreviation is ambiguous. |
| `base-revision-missing` | error | No `baseRevision`. The successor has no tree to start from. |
| `blocker-invalid` | error | A blocker is not an object with a usable `summary`, or carries an unknown field. |
| `blockers-missing` | error | No `blockers` array. An absent list is not a statement that there are none. |
| `carried-in-invalid` | error | `carriedIn` is not a relative path naming the artefact that carries the change. |
| `carried-in-on-committed-change` | warning | A change is both committed and carried separately. One of the two is wrong. |
| `change-committed-unknown` | error | A change does not say whether it is committed, so whether the successor can obtain it is unknown. |
| `change-invalid` | error | A change is not an object, has no usable `status`, or carries an unknown field. |
| `change-path-duplicate` | error | Two entries describe the same path, so the packet says two things about one file. |
| `change-path-invalid` | error | A changed path is absolute, steps outside with `..`, is empty, or carries a control or bidi character. |
| `changes-missing` | error | No `changes` array. "Nothing changed" and "nobody wrote it down" are different handoffs. |
| `check-excludes-uncommitted` | warning | A check passed but does not claim to cover the packet's uncommitted changes. |
| `check-invalid` | error | A check is not an object, or has no usable name, command or result. |
| `check-not-passing` | warning | A recorded check did not pass. The successor inherits it. |
| `check-revision-mismatch` | warning | A check ran at a revision other than the base revision, so it describes a different tree. |
| `check-revision-missing` | error | A check does not say which revision it ran at. A result that floats free of a revision says nothing. |
| `checks-missing` | error | No `checks` array. An absent list is not an empty one. |
| `credential-in-packet` | error | A string matches the shape of a credential. The matched value is never reproduced in the report. |
| `field-too-long` | error | One string is past `maxFieldChars`. A packet is a summary. |
| `generated-in-future` | warning | The packet is dated after the evaluation instant. One of the two clocks is wrong. |
| `generated-invalid` | error | `generated` is not a UTC `YYYY-MM-DDTHH:MM:SSZ` instant. |
| `generated-missing` | error | No `generated` instant, so the packet's age cannot be judged. |
| `input-not-json` | error | The packet did not parse. The failure is described without reproducing the document. |
| `input-not-utf8` | error | The packet is not valid UTF-8. Decoding is strict. |
| `input-too-large` | error | The packet is past `maxDocumentBytes`. It was not parsed. |
| `input-unreadable` | error | The packet could not be opened. |
| `next-action-missing` | error | No `nextAction`. |
| `no-changes-declared` | warning | The packet declares no changed files at all. Valid, and worth a second look. |
| `no-checks-declared` | warning | No completed checks, so nothing is known to have been run at this revision. |
| `objective-missing` | error | No `objective`. |
| `packet-invalid` | error | The packet is not a JSON object. |
| `packet-stale` | warning | The packet is older than `maxAgeHours`. A handoff describes a working tree, and a working tree moves. |
| `packet-too-deep` | error | The packet nests past `maxDepth`, so it was not scanned and nothing is claimed about what it carries. |
| `packet-unknown-field` | error | A top-level field this build does not know. Refused rather than ignored, so a typo cannot disable something. |
| `path-escapes-root` | error | The packet resolves outside `--root`, through a symbolic link or otherwise. It was not read. |
| `repository-missing` | error | No `repository`. |
| `schema-version-unsupported` | error | The packet declares a `schemaVersion` this build does not understand. It was not interpreted. |
| `time-budget-exceeded` | error | `maxRuntimeMs` expired mid-run. The rest of the packet was not examined. |
| `too-many-entries` | error | One list is past `maxEntries`. None of its entries were examined. |
| `too-many-findings` | error | The report reached `maxFindings`. It is partial, and therefore incomplete. |
| `too-many-nodes` | error | The packet holds more values than `maxNodes`, so it was not scanned and nothing is claimed about what it carries. |
| `transcript-embedded` | error | One string opens `maxTranscriptTurns` or more conversational turns. A packet states what happened; it does not carry the conversation. |
| `uncommitted-change-unreachable` | error | A change is uncommitted and nothing carries it. It exists only in the sender's working tree. |

## Which rules make a run incomplete

`input-not-json`, `input-not-utf8`, `input-too-large`, `input-unreadable`,
`packet-too-deep`, `path-escapes-root`, `schema-version-unsupported`,
`time-budget-exceeded`, `too-many-entries`, `too-many-findings` and
`too-many-nodes` all mean this tool could not read what it was given. Each marks
the run `incomplete` and exits 2.

Everything else is a fact the tool *did* obtain about a packet it read
completely. A field the packet omits is a fact about the packet, not a fact this
run failed to obtain, so it fails (exit 1) rather than reporting an incomplete
run.
