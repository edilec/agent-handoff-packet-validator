# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and rule ids are part
of the public surface: renaming one is a breaking change and is recorded here.

## [0.1.0] - 2026-09-14

### Added

- Validation of the nine required handoff fields, with an absent list never
  treated as an empty one.
- `base-revision-missing` and `base-revision-invalid`: a full 40-character
  lowercase revision is required, because a branch moves and an abbreviation is
  ambiguous.
- `uncommitted-change-unreachable`: a change marked uncommitted with nothing
  named in `carriedIn` fails, because the file exists only in the sender's
  working tree.
- `change-committed-unknown`: a change that omits `committed` is unknown, not
  committed.
- Credential scanning over every string in the document, including field names
  and fields this build does not recognise. The matched value is never
  reproduced, and every string in a finding is redacted on the way out.
- `transcript-embedded` and `field-too-long`: a packet is a summary.
- `packet-stale` against an injected evaluation instant (`--now`), recorded in
  `summary.evaluatedAt`.
- `branch-invalid`: `branch` is optional, which means the packet may omit it,
  not that anything may be written there. A declared `branch` that is not a
  usable name is refused rather than accepted and ignored. The same applies to
  every other optional field: a change's `note` and a blocker's `owner` and
  `detail` are refused as `change-invalid` and `blocker-invalid` when declared
  and unusable, and a check's `includesUncommitted` is refused as `check-invalid`
  when it is declared as anything but a boolean, rather than being read as
  `false`.
- Forty-seven rules with a frozen severity table, documented in
  `docs/packet-rules.md`.
- Limits for document size, nesting depth, node count, list length, findings and
  run time, each enforced and each reported by name.
- A value the packet supplies that cannot be rendered as a string -- an object
  with a non-callable `toString` -- is described by its shape (`[object]`,
  `[array]`) and the run reports the packet as invalid with status `incomplete`,
  rather than aborting with an empty stdout.
- Examples: `examples/ready` (exit 0) and `examples/handoff-not-ready` (exit 1).
