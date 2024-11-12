# Agent Handoff Packet Validator

Check that a handoff packet says enough for another agent to continue — and
carries nothing it should not.

- **Repository:** [edilec/agent-handoff-packet-validator](https://github.com/edilec/agent-handoff-packet-validator)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## Why this exists

A handoff packet is the document one agent leaves for the next. Two ways it goes
wrong, and both of them look fine to a reader:

1. **The successor cannot act on it.** No base revision, so every path, diff and
   check result in the packet is relative to a tree nobody can name. Or a file
   that exists only in the sender's working tree, named in the packet as though
   naming it moved it. The packet reads as complete and is unusable.
2. **It carries what it should not.** A credential pasted in with the command it
   was part of, or a whole transcript pasted in place of a summary. Packets get
   forwarded, logged and quoted in reviews.

This tool reads one packet and reports on it. It runs no git command, opens no
repository, resolves no changed file, opens no socket and writes nothing
anywhere.

## Quick start

```bash
node bin/agent-handoff-packet-validator.mjs \
  --root examples/ready \
  --now 2026-09-14T12:00:00Z
```

```
agent-handoff-packet-validator: pass (evaluated 2026-09-14T12:00:00Z)
  17 component(s) checked, 0 error(s), 0 warning(s)
  3 change(s), 1 uncommitted (1 carried), 2 check(s), 0 blocker(s), 3 acceptance criteria
```

That packet has an uncommitted file and still passes, because a patch travels
with it and the packet says so. The failing example (`npm run example:failing`,
`exit 1`) is the same handoff written badly:

```bash
node bin/agent-handoff-packet-validator.mjs \
  --root examples/handoff-not-ready --now 2026-09-14T12:00:00Z
```

```
  ERROR  base-revision-missing           handoff.json/baseRevision
  ERROR  uncommitted-change-unreachable  handoff.json/changes/0
  ERROR  credential-in-packet            handoff.json/checks/0/command
  ERROR  transcript-embedded             handoff.json/nextAction
  WARN   check-excludes-uncommitted      handoff.json/checks/0/includesUncommitted
  WARN   packet-stale                    handoff.json/generated
```

## The packet

```json
{
  "schemaVersion": "1",
  "generated": "2026-09-14T09:30:00Z",
  "objective": "Make the export job retry a failed upload three times before giving up.",
  "repository": "services/export-worker",
  "branch": "retry-uploads",
  "baseRevision": "3f9a2c1d4e5b6a7c8d9e0f1a2b3c4d5e6f708192",
  "changes": [
    { "path": "src/upload.mjs", "status": "modified", "committed": true },
    {
      "path": "docs/retry-policy.md",
      "status": "added",
      "committed": false,
      "carriedIn": "patches/0001-retry-policy-doc.patch"
    }
  ],
  "acceptance": ["A failed upload is retried three times with the documented backoff."],
  "checks": [
    {
      "name": "unit",
      "command": "npm test",
      "result": "pass",
      "revision": "3f9a2c1d4e5b6a7c8d9e0f1a2b3c4d5e6f708192",
      "includesUncommitted": true
    }
  ],
  "blockers": [],
  "nextAction": "Apply the patch, then wire the backoff constant into the worker configuration."
}
```

Nine required fields: `objective`, `repository`, `baseRevision`, `changes`,
`acceptance`, `checks`, `blockers`, `nextAction`, `generated`. `branch` and
`schemaVersion` are optional; anything else is refused as an unknown field, so a
typo cannot quietly become a field nobody reads.

**An absent list is never an empty one.** `"blockers": []` says there are no
blockers. Omitting `blockers` says nobody wrote it down, and those are different
handoffs. The same goes for `changes`, `checks` and `acceptance`, and for a
change that omits `committed`: whether the successor can obtain the file is
exactly what that flag answers, so it is required rather than assumed.

## What a failure means

| Situation | Rule | Why it matters |
| --- | --- | --- |
| No `baseRevision` | `base-revision-missing` | Every path and result in the packet is relative to a tree nobody can name. |
| `"baseRevision": "main"` | `base-revision-invalid` | A branch moves. An abbreviation is ambiguous in a repository that has grown. |
| Uncommitted, nothing carrying it | `uncommitted-change-unreachable` | The file is in no revision the successor can check out, and naming it does not move it. |
| A credential-shaped string | `credential-in-packet` | The packet is forwarded, logged and quoted. **The matched value is never reproduced in the report.** |
| Six speaker-labelled lines in one field | `transcript-embedded` | A packet states what happened; it does not carry the conversation it happened in. |
| A check with no revision | `check-revision-missing` | A result that floats free of a revision says nothing about the tree anyone will check out. |

All 46 rules are in [docs/packet-rules.md](./docs/packet-rules.md).

## Output

`stdout` carries the JSON report and nothing else. `stderr` carries the human
summary and diagnostics. The report follows the house contract, with a summary
that counts what was read:

```json
{
  "schemaVersion": "1",
  "tool": "agent-handoff-packet-validator",
  "status": "pass",
  "summary": {
    "checked": 17, "errors": 0, "warnings": 0,
    "changes": 3, "uncommittedChanges": 1, "carriedChanges": 1,
    "checks": 2, "checksNotPassing": 0, "acceptanceCriteria": 3, "blockers": 0,
    "credentialMatches": 0, "transcriptMatches": 0,
    "baseRevisionDeclared": true, "ageHours": 2,
    "evaluatedAt": "2026-09-14T12:00:00Z"
  },
  "findings": []
}
```

Findings sort by `(location.file, location.pointer, ruleId, message)`. Pointers
compare as strings, so `/changes/10` precedes `/changes/9`. All comparisons are
by UTF-16 code unit; `localeCompare` and `Intl.Collator` are never used, because
ICU data differs between Node builds and two correct machines would disagree
about the same report.

The evaluation instant is an input (`--now`), so two runs over the same packet
produce byte-identical stdout.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | the packet was read and no error-severity rule fired |
| `1` | the packet was read and at least one error-severity rule fired |
| `2` | invalid configuration (**stdout is empty**), or evidence that could not be obtained (an `incomplete` report on stdout) |

**Where the line falls.** A field the packet omits is a fact *about* the packet:
the run read everything it was given, and the verdict is `fail`. A document this
tool could not read, decode, parse or finish walking is evidence it did not
obtain, and that is `incomplete` — never a pass, and never reported as absence.
An unreadable packet does not say "no base revision was supplied"; it says the
packet could not be read, because nothing is known about what it supplies.

## Thresholds and limits

Thresholds are verdicts about a packet that was read completely. Crossing one is
a finding.

| Threshold | Default | Flag |
| --- | ---: | --- |
| `maxAgeHours` | 72 | `--max-age-hours` |
| `maxFieldChars` | 2000 | `--max-field-chars` |
| `maxTranscriptTurns` | 6 | `--max-transcript-turns` |

Limits are parser bounds. Reaching one means part of the packet was never read,
so the run is `incomplete` with a finding naming the limit — never a silent
truncation.

| Limit | Default | Flag |
| --- | ---: | --- |
| `maxDepth` | 12 | `--max-depth` |
| `maxDocumentBytes` | 262144 | `--max-document-bytes` |
| `maxEntries` | 500 | `--max-entries` |
| `maxFindings` | 1000 | `--max-findings` |
| `maxNodes` | 20000 | `--max-nodes` |
| `maxRuntimeMs` | 10000 | `--max-runtime-ms` |

## Non-goals

Stated plainly, because a tool trusted for something it does not do is worse
than no tool.

- **It is not a secret scanner.** Ten published credential formats, matched as
  shapes, with no entropy heuristic and no verification. It will miss a bespoke
  token and it will flag a documentation example. A clean report means nothing
  matched these ten patterns — not that the packet holds no credential. What it
  does guarantee is that a value it *did* match is never reproduced: the report
  carries the pattern name, the offset and the length, and every string in a
  finding is redacted on the way out, including a field name the packet invented.
- **It runs no git.** The revision is checked for shape, never for existence.
  The changed paths are checked for shape, never opened. A packet naming a
  revision that was never pushed, or a file that does not exist, passes.
- **It does not verify that a check ever ran.** `"result": "pass"` is a claim
  the packet makes. This tool checks that the claim names a command and a
  revision; it does not re-run anything.
- **The transcript rule is a heuristic.** Speaker-labelled line starts, plus a
  blunt length threshold. A transcript with no labels and under the length
  threshold gets through.
- **It writes nothing.** One file is read. There is no `--out`, by design.
- **A pass is not a statement that the handoff is a good one.** It means the
  packet is complete, internally consistent and clean of what this tool looks
  for. Whether the objective is the right one is not a question a validator can
  answer.

## Verification

```bash
npm run check    # lint, tests, the passing example, the failing example, npm pack --dry-run
```

The suite pins behaviour rather than declarations. Severity is asserted through
real exit codes for every rule in the table; ordering is asserted with inputs
that code-unit order and ICU collation genuinely disagree about; every character
class that forges or hides output is driven through an identifier as well as an
excerpt; every credential pattern has an end-to-end case asserting the value
reaches neither stream. The redaction of a credential used as a *field name* is
in the suite because a test found that hole after the scanner had already been
written carefully.

## License

MIT. See [LICENSE](./LICENSE).
