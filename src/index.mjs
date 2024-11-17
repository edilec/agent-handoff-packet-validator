/**
 * agent-handoff-packet-validator -- check that a handoff packet says enough for
 * another agent to continue, and carries nothing it should not.
 *
 * A handoff packet is the document one agent leaves for the next: what the
 * objective is, which repository and which base revision, what has changed,
 * what would count as done, what has been checked, what is blocked, and what to
 * do next. This tool reads one such document and reports on it. It runs no git
 * command, opens no repository, resolves no changed file and touches no
 * account: every sentence in the report is a sentence about the packet.
 *
 * The two failures it exists to catch:
 *
 * 1. **A packet the successor cannot act on.** No base revision, or a file that
 *    exists only in the sender's working tree with nothing carrying it across.
 *    Both look complete to a reader and are unusable in practice.
 * 2. **A packet carrying what it should not.** A credential pasted in with a
 *    command, or a whole transcript pasted in place of a summary. Packets are
 *    forwarded, logged and quoted in reviews.
 *
 * Where the line between `fail` and `incomplete` falls: a field the packet
 * omits is a fact about the packet, and it fails. A document this tool could
 * not read, decode, parse or finish walking is evidence it did not obtain, and
 * that is `incomplete` -- never a pass, and never reported as absence.
 */

import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  ALLOWED_BLOCKER_FIELDS, ALLOWED_CHANGE_FIELDS, ALLOWED_CHECK_FIELDS, ALLOWED_PACKET_FIELDS,
  CHANGE_STATUSES, CHECK_RESULTS, REQUIRED_PACKET_FIELDS,
  evaluationInstant, formatInstant, hourDifference, isFullRevision, isUsablePath, parseInstant,
} from './packet.mjs'
import { countTranscriptTurns, findCredentials, redactCredentials, walkStrings } from './scan.mjs'
import {
  byCodeUnit, decodeUtf8, escapePointerSegment, excerpt, hasForbiddenCharacter, isPlainObject,
  parseFailureDetail,
} from './text.mjs'

export {
  ALLOWED_BLOCKER_FIELDS, ALLOWED_CHANGE_FIELDS, ALLOWED_CHECK_FIELDS, ALLOWED_PACKET_FIELDS,
  CHANGE_STATUSES, CHECK_RESULTS, REQUIRED_PACKET_FIELDS,
  evaluationInstant, formatInstant, hourDifference, isFullRevision, isUsablePath, parseInstant,
} from './packet.mjs'
export { CREDENTIAL_PATTERNS, countTranscriptTurns, findCredentials, redactCredentials, walkStrings } from './scan.mjs'
export {
  CONTROL_CLASSES, EXCERPT_LIMIT, byCodeUnit, decodeUtf8, escapePointerSegment, excerpt,
  hasForbiddenCharacter, isPlainObject, parseFailureDetail, renderable,
} from './text.mjs'

export const TOOL_ID = 'agent-handoff-packet-validator'
export const REPORT_SCHEMA_VERSION = '1'
export const SUPPORTED_PACKET_VERSION = '1'
export const DEFAULT_PACKET_NAME = 'handoff.json'

/**
 * Parser bounds. Reaching one is an `incomplete` run with a finding naming the
 * limit -- never a silent truncation, and never a pass over the part that was
 * reached.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 12,
  maxDocumentBytes: 262144,
  maxEntries: 500,
  maxFindings: 1000,
  maxNodes: 20000,
  maxRuntimeMs: 10000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxDepth: 64,
  maxDocumentBytes: 16777216,
  maxEntries: 100000,
  maxFindings: 20000,
  maxNodes: 2000000,
  maxRuntimeMs: 600000,
})

/**
 * Verdict thresholds. These are judgements about a packet that was read
 * completely, so crossing one is a finding about the packet -- not an
 * incomplete run.
 */
export const DEFAULT_POLICY = Object.freeze({
  maxAgeHours: 72,
  maxFieldChars: 2000,
  maxTranscriptTurns: 6,
})

export const HARD_POLICY = Object.freeze({
  maxAgeHours: 8760,
  maxFieldChars: 200000,
  maxTranscriptTurns: 1000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run fails, so it lives in one place and every
 * finding takes its value from here; an unknown rule id throws rather than
 * defaulting. `test/rule-catalog.test.mjs` checks this against
 * docs/packet-rules.md in both directions, which is a consistency check and not
 * the defence -- a table, a document and a test's expected map are three
 * declarations that one coordinated edit satisfies.
 * `test/severity-outcomes.test.mjs` is the defence: it drives a real packet
 * through the real CLI for every rule below and asserts the exit code.
 */
export const RULE_SEVERITY = Object.freeze({
  'acceptance-empty': 'error',
  'acceptance-invalid': 'error',
  'acceptance-missing': 'error',
  'base-revision-invalid': 'error',
  'base-revision-missing': 'error',
  'blocker-invalid': 'error',
  'blockers-missing': 'error',
  'carried-in-invalid': 'error',
  'carried-in-on-committed-change': 'warning',
  'change-committed-unknown': 'error',
  'change-invalid': 'error',
  'change-path-duplicate': 'error',
  'change-path-invalid': 'error',
  'changes-missing': 'error',
  'check-excludes-uncommitted': 'warning',
  'check-invalid': 'error',
  'check-not-passing': 'warning',
  'check-revision-mismatch': 'warning',
  'check-revision-missing': 'error',
  'checks-missing': 'error',
  'credential-in-packet': 'error',
  'field-too-long': 'error',
  'generated-in-future': 'warning',
  'generated-invalid': 'error',
  'generated-missing': 'error',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'next-action-missing': 'error',
  'no-changes-declared': 'warning',
  'no-checks-declared': 'warning',
  'objective-missing': 'error',
  'packet-invalid': 'error',
  'packet-stale': 'warning',
  'packet-too-deep': 'error',
  'packet-unknown-field': 'error',
  'path-escapes-root': 'error',
  'repository-missing': 'error',
  'schema-version-unsupported': 'error',
  'time-budget-exceeded': 'error',
  'too-many-entries': 'error',
  'too-many-findings': 'error',
  'too-many-nodes': 'error',
  'transcript-embedded': 'error',
  'uncommitted-change-unreachable': 'error',
})

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze(['limits', 'monotonic', 'now', 'packet', 'policy', 'root'])

export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(
        `Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * Validate the verdict thresholds.
 *
 * An unknown key throws rather than being ignored: a one-character typo in
 * `maxAgeHours` would otherwise turn a real staleness finding into a green run,
 * which is a defect this catalog has already shipped once.
 */
export function validatePolicy(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('policy must be an object')
  const policy = { ...DEFAULT_POLICY }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_POLICY, key)) {
      throw new TypeError(
        `Unknown policy key "${excerpt(key, 60)}"; known keys are ${Object.keys(DEFAULT_POLICY).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_POLICY[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`policy.${key} must be an integer between 1 and ${cap}`)
    }
    policy[key] = value
  }
  return Object.freeze(policy)
}

/**
 * True when `candidate` is the real root itself or lies beneath it. Both sides
 * must already be real paths: comparing a real root against an unresolved path
 * refuses legitimate files whenever the root is reached through a symbolic link,
 * and a false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised AND redacted here -- file, pointer,
 * message, suggestion and evidence alike. A sibling tool sanitised its evidence
 * field carefully and left identifiers raw, so a record id holding a newline
 * forged an extra line in the human report; the same shape of hole let a token
 * used as a field NAME reach this report through the message that said the
 * field was unknown, until a test went looking for it.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/packet-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(redactCredentials(row.message), MESSAGE_LIMIT),
    location: {
      file: excerpt(redactCredentials(row.file), LOCATION_LIMIT),
      pointer: excerpt(redactCredentials(row.pointer ?? ''), LOCATION_LIMIT),
    },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(redactCredentials(row.evidence))
  if (row.suggestion !== undefined) finding.suggestion = excerpt(redactCredentials(row.suggestion), SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: `location.file`, `location.pointer`, `ruleId`,
 * `message`.
 *
 * Pointers compare as strings, so `/changes/10` precedes `/changes/9`. The
 * message is part of the key because several rules deliberately anchor more
 * than one finding at the same pointer -- a field name and its value share one.
 */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer, b.location.pointer)
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

class Run {
  constructor(file) {
    this.file = file
    this.rows = []
    this.incomplete = false
  }

  add(row) {
    this.rows.push({ pointer: '', file: this.file, ...row })
  }

  /**
   * Record a finding AND mark the run incomplete, in one call.
   *
   * The two belong together: every caller is a place where the tool wanted a
   * fact about the packet and did not get one. Splitting them into two
   * statements is how a deleted line leaves an unread input reporting a pass.
   */
  addUnknown(row) {
    this.incomplete = true
    this.add(row)
  }
}

async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/**
 * Scan every string in the document for what a packet must not carry.
 *
 * This runs BEFORE the schema is checked, on purpose: a credential sitting in a
 * field this build does not recognise is still a credential in a file that gets
 * forwarded, and a scan that only looked at known fields would miss exactly the
 * case where somebody pasted something in a hurry.
 */
function scanStrings(run, strings, policy, state) {
  for (const entry of strings) {
    const where = entry.isKey ? 'The field name at' : 'The value at'
    if (entry.value.length > policy.maxFieldChars) {
      state.tooLong += 1
      run.add({
        pointer: entry.pointer,
        ruleId: 'field-too-long',
        message: `${where} ${entry.pointer === '' ? 'the root' : entry.pointer} is ${entry.value.length} characters, past the maxFieldChars threshold of ${policy.maxFieldChars}. A handoff packet is a summary; a successor reads it, so a wall of text in one field is the same failure as a pasted transcript.`,
        suggestion: 'Summarise the field, and leave the long form where it already lives.',
      })
    }

    const turns = countTranscriptTurns(entry.value)
    if (turns >= policy.maxTranscriptTurns) {
      state.transcripts += 1
      run.add({
        pointer: entry.pointer,
        ruleId: 'transcript-embedded',
        message: `${where} ${entry.pointer === '' ? 'the root' : entry.pointer} opens ${turns} conversational turns, at or past the maxTranscriptTurns threshold of ${policy.maxTranscriptTurns}. A packet states what happened; it does not carry the conversation it happened in.`,
        evidence: `${turns} lines begin with a speaker label`,
        suggestion: 'Replace the transcript with the decisions it led to and the state it left behind.',
      })
    }

    for (const hit of findCredentials(entry.value)) {
      state.credentials += 1
      run.add({
        pointer: entry.pointer,
        ruleId: 'credential-in-packet',
        message: `${where} ${entry.pointer === '' ? 'the root' : entry.pointer} matches the shape of a credential (${hit.id}). A packet is forwarded, logged and quoted in reviews, so it must not carry one.`,
        // The pattern id is this module's own; the offset and length are
        // numbers. The matched text is never read out of the scanner, so there
        // is no path by which it reaches a stream.
        evidence: `${hit.id} matched ${hit.length} characters at offset ${hit.index}; the value is not reproduced`,
        suggestion: 'Remove it from the packet, and rotate it if it was ever real.',
      })
    }
  }
}

function requireString(run, document, field, ruleId, state) {
  state.checked += 1
  const value = document[field]
  if (typeof value === 'string' && value.trim().length > 0) return
  run.add({
    pointer: `/${field}`,
    ruleId,
    message: `The packet declares no usable "${field}". A successor cannot start without it, and an absent field is not an empty one.`,
    suggestion: `Declare "${field}" as a non-empty string.`,
  })
}

function validateChanges(run, document, limits, state, deadline) {
  state.checked += 1
  if (!Array.isArray(document.changes)) {
    run.add({
      pointer: '/changes',
      ruleId: 'changes-missing',
      message: 'The packet declares no "changes" array. An absent list is not an empty one: the successor cannot tell "nothing changed" from "nobody wrote it down".',
      suggestion: 'Declare "changes" as an array, empty if the tree really is clean.',
    })
    return
  }
  if (document.changes.length > limits.maxEntries) {
    run.addUnknown({
      pointer: '/changes',
      ruleId: 'too-many-entries',
      message: `The packet declares ${document.changes.length} changes, past the maxEntries limit of ${limits.maxEntries}. None were examined.`,
      suggestion: 'Raise --max-entries, or hand off a narrower change set.',
    })
    return
  }
  if (document.changes.length === 0) {
    run.add({
      pointer: '/changes',
      ruleId: 'no-changes-declared',
      message: 'The packet declares no changed files at all. That is a valid statement, and it is worth a second look on a handoff.',
      suggestion: 'Confirm the working tree really is clean at the base revision.',
    })
  }

  const seen = new Map()
  for (const [index, change] of document.changes.entries()) {
    if (deadline()) return
    state.checked += 1
    const pointer = `/changes/${index}`
    if (!isPlainObject(change)) {
      run.add({
        pointer,
        ruleId: 'change-invalid',
        message: 'This change entry is not an object with a path, a status and a committed flag.',
        suggestion: 'Write each change as { "path": "...", "status": "modified", "committed": true }.',
      })
      continue
    }
    for (const key of Object.keys(change).sort(byCodeUnit)) {
      if (!ALLOWED_CHANGE_FIELDS.includes(key)) {
        run.add({
          pointer: `${pointer}/${escapePointerSegment(key)}`,
          ruleId: 'change-invalid',
          message: `Unknown change field "${excerpt(key, 60)}"; known fields are ${ALLOWED_CHANGE_FIELDS.join(', ')}.`,
          suggestion: 'Remove the field, or correct the spelling of the one you meant.',
        })
      }
    }

    if (!isUsablePath(change.path)) {
      run.add({
        pointer: `${pointer}/path`,
        ruleId: 'change-path-invalid',
        message: 'This change has no usable "path": it must be a relative path of 1-400 characters, with no "..", no leading separator and no control character.',
        suggestion: 'Write the path as the repository sees it, relative to its root.',
      })
    } else {
      state.changes += 1
      if (seen.has(change.path)) {
        run.add({
          pointer: `${pointer}/path`,
          ruleId: 'change-path-duplicate',
          message: `The path "${excerpt(change.path, 120)}" is listed more than once, so the packet states two things about one file.`,
          suggestion: 'Keep one entry per path.',
        })
      } else seen.set(change.path, index)
    }

    if (!CHANGE_STATUSES.includes(change.status)) {
      run.add({
        pointer: `${pointer}/status`,
        ruleId: 'change-invalid',
        message: `This change has no usable "status"; it must be one of ${CHANGE_STATUSES.join(', ')}.`,
        suggestion: 'State what happened to the file.',
      })
    }

    const hasCarrier = Object.hasOwn(change, 'carriedIn')
    if (hasCarrier && !isUsablePath(change.carriedIn)) {
      run.add({
        pointer: `${pointer}/carriedIn`,
        ruleId: 'carried-in-invalid',
        message: '"carriedIn" must be a relative path naming the patch, bundle or attachment that carries this file to the successor.',
        suggestion: 'Name the artefact that travels with the packet, or commit the change instead.',
      })
    }

    if (typeof change.committed !== 'boolean') {
      /**
       * Whether the successor can obtain this file is exactly what "committed"
       * answers. Defaulting it either way would make the tool's most important
       * verdict depend on a guess, so the flag is required.
       */
      run.add({
        pointer: `${pointer}/committed`,
        ruleId: 'change-committed-unknown',
        message: 'This change does not say whether it is committed, so whether the successor can obtain it is unknown. An absent flag is not "committed".',
        suggestion: 'Declare "committed": true or false for every change.',
      })
      continue
    }

    if (change.committed === true) {
      if (hasCarrier) {
        run.add({
          pointer: `${pointer}/carriedIn`,
          ruleId: 'carried-in-on-committed-change',
          message: 'This change is marked committed and also carried in a separate artefact. One of the two is wrong, and the successor cannot tell which.',
          suggestion: 'Drop "carriedIn" for a committed change, or mark the change uncommitted.',
        })
      }
      continue
    }

    state.uncommitted += 1
    if (hasCarrier && isUsablePath(change.carriedIn)) {
      state.carried += 1
      continue
    }
    /**
     * The acceptance criterion this tool was built for. An uncommitted file is
     * unique to the sender's working tree: it is in no revision the successor
     * can check out, and naming it in the packet does not move it. Without a
     * carrier the handoff is unusable, and it looks complete.
     */
    run.add({
      pointer,
      ruleId: 'uncommitted-change-unreachable',
      message: `"${excerpt(isUsablePath(change.path) ? change.path : `changes[${index}]`, 120)}" is uncommitted and nothing carries it. It exists only in the sender's working tree, so the successor cannot obtain it from the base revision.`,
      suggestion: 'Commit the change, or attach a patch and name it in "carriedIn".',
    })
  }
}

function validateChecks(run, document, limits, state, baseRevision, deadline) {
  state.checked += 1
  if (!Array.isArray(document.checks)) {
    run.add({
      pointer: '/checks',
      ruleId: 'checks-missing',
      message: 'The packet declares no "checks" array. An absent list is not an empty one: "nothing was run" and "nobody wrote down what was run" are different handoffs.',
      suggestion: 'Declare "checks" as an array, empty if nothing has been run.',
    })
    return
  }
  if (document.checks.length > limits.maxEntries) {
    run.addUnknown({
      pointer: '/checks',
      ruleId: 'too-many-entries',
      message: `The packet declares ${document.checks.length} checks, past the maxEntries limit of ${limits.maxEntries}. None were examined.`,
      suggestion: 'Raise --max-entries, or summarise the checks.',
    })
    return
  }
  if (document.checks.length === 0) {
    run.add({
      pointer: '/checks',
      ruleId: 'no-checks-declared',
      message: 'The packet declares no completed checks, so nothing is known to have been run at this revision.',
      suggestion: 'Run the project check and record it, or say in "blockers" why it could not be run.',
    })
  }

  for (const [index, check] of document.checks.entries()) {
    if (deadline()) return
    state.checked += 1
    const pointer = `/checks/${index}`
    if (!isPlainObject(check)) {
      run.add({
        pointer,
        ruleId: 'check-invalid',
        message: 'This check entry is not an object with a name, a command, a result and the revision it ran at.',
        suggestion: 'Write each check as { "name": "...", "command": "...", "result": "pass", "revision": "<40 hex>" }.',
      })
      continue
    }
    for (const key of Object.keys(check).sort(byCodeUnit)) {
      if (!ALLOWED_CHECK_FIELDS.includes(key)) {
        run.add({
          pointer: `${pointer}/${escapePointerSegment(key)}`,
          ruleId: 'check-invalid',
          message: `Unknown check field "${excerpt(key, 60)}"; known fields are ${ALLOWED_CHECK_FIELDS.join(', ')}.`,
          suggestion: 'Remove the field, or correct the spelling of the one you meant.',
        })
      }
    }

    const name = typeof check.name === 'string' && check.name.trim().length > 0 ? check.name : null
    if (name === null) {
      run.add({
        pointer: `${pointer}/name`,
        ruleId: 'check-invalid',
        message: 'This check has no usable "name".',
        suggestion: 'Name the check as the project names it.',
      })
    }
    if (typeof check.command !== 'string' || check.command.trim().length === 0) {
      run.add({
        pointer: `${pointer}/command`,
        ruleId: 'check-invalid',
        message: 'This check declares no "command", so nobody can repeat it. A result without the command that produced it is a claim, not evidence.',
        suggestion: 'Record the exact command that was run.',
      })
    }
    if (!CHECK_RESULTS.includes(check.result)) {
      run.add({
        pointer: `${pointer}/result`,
        ruleId: 'check-invalid',
        message: `This check has no usable "result"; it must be one of ${CHECK_RESULTS.join(', ')}.`,
        suggestion: 'Record what the check did.',
      })
      continue
    }
    state.checks += 1

    if (!isFullRevision(check.revision)) {
      run.add({
        pointer: `${pointer}/revision`,
        ruleId: 'check-revision-missing',
        message: 'This check does not say which revision it ran at, as a full 40-character hexadecimal object name. A result that floats free of a revision says nothing about the tree the successor will check out.',
        suggestion: 'Record the revision the check ran against.',
      })
    } else if (baseRevision !== null && check.revision !== baseRevision) {
      run.add({
        pointer: `${pointer}/revision`,
        ruleId: 'check-revision-mismatch',
        message: 'This check ran at a revision other than the packet\'s base revision, so it describes a different tree.',
        evidence: `check revision ${check.revision.slice(0, 12)}..., base revision ${baseRevision.slice(0, 12)}...`,
        suggestion: 'Re-run the check at the base revision, or say in "blockers" why the difference is acceptable.',
      })
    }

    if (check.result !== 'pass') {
      state.notPassing += 1
      run.add({
        pointer: `${pointer}/result`,
        ruleId: 'check-not-passing',
        message: `The check "${excerpt(name ?? `checks[${index}]`, 80)}" is recorded as "${check.result}". The successor inherits it; this is reported so the handoff is not read as green.`,
        suggestion: 'Fix it before handing off, or name it in "blockers" with what is known about it.',
      })
    }

    if (check.result === 'pass' && state.uncommitted > 0 && check.includesUncommitted !== true) {
      run.add({
        pointer: `${pointer}/includesUncommitted`,
        ruleId: 'check-excludes-uncommitted',
        message: `This check passed but does not claim to cover the ${state.uncommitted} uncommitted change(s) in the packet, so the pass describes a tree nobody will check out.`,
        suggestion: 'Re-run the check over the working tree and set "includesUncommitted": true, or commit the changes.',
      })
    }
  }
}

function validateList(run, document, field, ruleId, limits, state) {
  state.checked += 1
  const value = document[field]
  if (!Array.isArray(value)) {
    run.add({
      pointer: `/${field}`,
      ruleId,
      message: `The packet declares no "${field}" array. An absent list is not an empty one.`,
      suggestion: `Declare "${field}" as an array, empty if there really are none.`,
    })
    return null
  }
  if (value.length > limits.maxEntries) {
    run.addUnknown({
      pointer: `/${field}`,
      ruleId: 'too-many-entries',
      message: `The packet declares ${value.length} entries in "${field}", past the maxEntries limit of ${limits.maxEntries}. None were examined.`,
      suggestion: 'Raise --max-entries, or summarise the list.',
    })
    return null
  }
  return value
}

/**
 * Validate a handoff packet.
 *
 * Returns a report. It throws only for configuration that never gave the run a
 * subject: an unusable root, an unknown option, an invalid limit or threshold.
 * Everything about the packet, including one that could not be read, comes back
 * as a report.
 */
export async function checkHandoffPacket(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }

  const limits = validateLimits(options.limits)
  const policy = validatePolicy(options.policy)
  const monotonic = options.monotonic ?? (() => performance.now())
  if (typeof monotonic !== 'function') throw new TypeError('monotonic must be a function returning milliseconds')
  const startedAt = monotonic()
  const evaluatedAt = evaluationInstant(options.now)

  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root is required')
  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new TypeError(`root is not a readable directory (${error.code ?? 'unreadable'})`)
  }

  const name = validateName(options.packet ?? DEFAULT_PACKET_NAME, 'packet')
  const file = relative(realRoot, resolve(realRoot, name)).split(sep).join('/')
  const run = new Run(file)
  const state = {
    checked: 0,
    changes: 0,
    uncommitted: 0,
    carried: 0,
    checks: 0,
    notPassing: 0,
    blockers: 0,
    acceptance: 0,
    credentials: 0,
    transcripts: 0,
    tooLong: 0,
    ageHours: null,
    baseRevision: null,
    evaluatedAt: evaluatedAt.iso,
  }

  let expired = false
  const deadline = () => {
    if (expired) return true
    if (monotonic() - startedAt <= limits.maxRuntimeMs) return false
    expired = true
    run.addUnknown({
      ruleId: 'time-budget-exceeded',
      message: `The maxRuntimeMs budget of ${limits.maxRuntimeMs} ms expired, so the rest of the packet was not examined. A partial pass is not a pass.`,
      suggestion: 'Raise --max-runtime-ms, or hand off a smaller packet.',
    })
    return true
  }

  const located = await resolveInput(realRoot, name)
  if (!located.ok) {
    run.addUnknown(located.reason === 'escapes'
      ? {
        ruleId: 'path-escapes-root',
        message: 'The packet resolves outside the declared root, so it was not read.',
        suggestion: 'Point --root at the directory that really holds the packet.',
      }
      : {
        ruleId: 'input-unreadable',
        message: `The packet could not be read (${excerpt(located.code ?? 'unreadable', 40)}).`,
        suggestion: 'Check the path and the file permissions.',
      })
    return buildReport(run, state, limits)
  }

  let bytes
  try {
    bytes = await readFile(located.real)
  } catch (error) {
    run.addUnknown({
      ruleId: 'input-unreadable',
      message: `The packet could not be read (${excerpt(error.code ?? 'unreadable', 40)}).`,
      suggestion: 'Check the path and the file permissions.',
    })
    return buildReport(run, state, limits)
  }

  if (bytes.byteLength > limits.maxDocumentBytes) {
    run.addUnknown({
      ruleId: 'input-too-large',
      message: `The packet is ${bytes.byteLength} bytes, past the maxDocumentBytes limit of ${limits.maxDocumentBytes}. It was not parsed.`,
      suggestion: 'Raise --max-document-bytes, or -- more likely -- write a shorter packet.',
    })
    return buildReport(run, state, limits)
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    run.addUnknown({
      ruleId: 'input-not-utf8',
      message: 'The packet is not valid UTF-8, so it was not parsed.',
      suggestion: 'Re-encode the packet as UTF-8.',
    })
    return buildReport(run, state, limits)
  }

  let document
  try {
    document = JSON.parse(decoded.text)
  } catch (error) {
    run.addUnknown({
      ruleId: 'input-not-json',
      // The detail describes where the parse failed and never reproduces the
      // document -- which matters most here, since the document is the one
      // most likely in this catalog to hold a credential.
      message: `The packet is not valid JSON: ${parseFailureDetail(error)}.`,
      suggestion: 'Validate the packet with a JSON parser before handing it over.',
    })
    return buildReport(run, state, limits)
  }

  if (!isPlainObject(document)) {
    run.add({
      ruleId: 'packet-invalid',
      message: 'The packet is not a JSON object.',
      suggestion: 'Write the packet as an object with the nine required fields.',
    })
    return buildReport(run, state, limits)
  }

  if (Object.hasOwn(document, 'schemaVersion') && document.schemaVersion !== SUPPORTED_PACKET_VERSION) {
    run.addUnknown({
      pointer: '/schemaVersion',
      ruleId: 'schema-version-unsupported',
      // Not `String(document.schemaVersion)`: a value carrying a non-callable
      // `toString` throws there, and this site is reached before any schema
      // check, so it would cost the report on any packet at all.
      message: `This build understands packet schemaVersion "${SUPPORTED_PACKET_VERSION}"; the packet declares "${excerpt(document.schemaVersion, 40)}". It was not interpreted.`,
      suggestion: 'Validate the packet with a build that understands its schema version.',
    })
    return buildReport(run, state, limits)
  }

  const walked = walkStrings(document, { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes })
  if (!walked.ok) {
    run.addUnknown(walked.reason === 'depth'
      ? {
        ruleId: 'packet-too-deep',
        message: `The packet nests deeper than the maxDepth limit of ${limits.maxDepth}, so it was not scanned for credentials or transcripts and nothing is claimed about what it carries.`,
        suggestion: 'Raise --max-depth, or flatten the packet.',
      }
      : {
        ruleId: 'too-many-nodes',
        message: `The packet holds more values than the maxNodes limit of ${limits.maxNodes}, so it was not scanned for credentials or transcripts and nothing is claimed about what it carries.`,
        suggestion: 'Raise --max-nodes, or write a shorter packet.',
      })
    return buildReport(run, state, limits)
  }

  scanStrings(run, walked.strings, policy, state)

  for (const key of Object.keys(document).sort(byCodeUnit)) {
    if (!ALLOWED_PACKET_FIELDS.includes(key)) {
      run.add({
        pointer: `/${escapePointerSegment(key)}`,
        ruleId: 'packet-unknown-field',
        message: `Unknown packet field "${excerpt(key, 60)}"; known fields are ${ALLOWED_PACKET_FIELDS.join(', ')}.`,
        suggestion: 'Remove the field, or correct the spelling of the one you meant.',
      })
    }
  }

  requireString(run, document, 'objective', 'objective-missing', state)
  requireString(run, document, 'repository', 'repository-missing', state)
  requireString(run, document, 'nextAction', 'next-action-missing', state)

  state.checked += 1
  if (!Object.hasOwn(document, 'baseRevision')) {
    run.add({
      pointer: '/baseRevision',
      ruleId: 'base-revision-missing',
      message: 'The packet declares no "baseRevision". Without it the successor has no tree to start from, and every path, diff and check result in the packet is relative to something nobody can name.',
      suggestion: 'Record the full 40-character revision the work started from.',
    })
  } else if (!isFullRevision(document.baseRevision)) {
    run.add({
      pointer: '/baseRevision',
      ruleId: 'base-revision-invalid',
      message: 'The "baseRevision" is not a full 40-character lowercase hexadecimal object name. A branch name moves and an abbreviated name is ambiguous; the successor needs one that still means this commit tomorrow.',
      suggestion: 'Record the full revision, not a branch, tag or short name.',
    })
  } else state.baseRevision = document.baseRevision

  state.checked += 1
  if (!Object.hasOwn(document, 'generated')) {
    run.add({
      pointer: '/generated',
      ruleId: 'generated-missing',
      message: 'The packet declares no "generated" instant, so nobody can tell whether it describes the tree as it is now or as it was last week.',
      suggestion: 'Record when the packet was written, as YYYY-MM-DDTHH:MM:SSZ.',
    })
  } else {
    const generated = parseInstant(document.generated)
    if (!generated.ok) {
      run.add({
        pointer: '/generated',
        ruleId: 'generated-invalid',
        message: 'The "generated" instant is not a UTC YYYY-MM-DDTHH:MM:SSZ timestamp. A timestamp with no zone is read as local time by some parsers, which would make the packet\'s age depend on the machine judging it.',
        suggestion: 'Write the instant in UTC, ending in Z.',
      })
    } else {
      const ageHours = hourDifference(generated.ms, evaluatedAt.ms)
      state.ageHours = ageHours
      if (ageHours < 0) {
        run.add({
          pointer: '/generated',
          ruleId: 'generated-in-future',
          message: `The packet is dated ${excerpt(document.generated, 40)}, which is after the evaluation instant ${evaluatedAt.iso}. One of the two clocks is wrong.`,
          suggestion: 'Correct the packet, or pass the instant it should be judged against with --now.',
        })
      } else if (ageHours > policy.maxAgeHours) {
        run.add({
          pointer: '/generated',
          ruleId: 'packet-stale',
          message: `The packet was written ${ageHours} hours ago, past the maxAgeHours threshold of ${policy.maxAgeHours}. A handoff describes a working tree, and a working tree moves.`,
          suggestion: 'Re-generate the packet against the current tree, or confirm nothing has moved since.',
        })
      }
    }
  }

  validateChanges(run, document, limits, state, deadline)
  validateChecks(run, document, limits, state, state.baseRevision, deadline)

  const acceptance = validateList(run, document, 'acceptance', 'acceptance-missing', limits, state)
  if (acceptance !== null) {
    if (acceptance.length === 0) {
      run.add({
        pointer: '/acceptance',
        ruleId: 'acceptance-empty',
        message: 'The packet lists no acceptance criteria, so the successor has no way to know when the objective has been met.',
        suggestion: 'State what would have to be true for this work to be done.',
      })
    }
    for (const [index, criterion] of acceptance.entries()) {
      state.checked += 1
      if (typeof criterion !== 'string' || criterion.trim().length === 0) {
        run.add({
          pointer: `/acceptance/${index}`,
          ruleId: 'acceptance-invalid',
          message: 'This acceptance criterion is not a non-empty string.',
          suggestion: 'Write each criterion as one testable sentence.',
        })
      } else state.acceptance += 1
    }
  }

  const blockers = validateList(run, document, 'blockers', 'blockers-missing', limits, state)
  if (blockers !== null) {
    for (const [index, blocker] of blockers.entries()) {
      state.checked += 1
      const pointer = `/blockers/${index}`
      if (!isPlainObject(blocker)) {
        run.add({
          pointer,
          ruleId: 'blocker-invalid',
          message: 'This blocker is not an object with a summary.',
          suggestion: 'Write each blocker as { "summary": "...", "owner": "..." }.',
        })
        continue
      }
      for (const key of Object.keys(blocker).sort(byCodeUnit)) {
        if (!ALLOWED_BLOCKER_FIELDS.includes(key)) {
          run.add({
            pointer: `${pointer}/${escapePointerSegment(key)}`,
            ruleId: 'blocker-invalid',
            message: `Unknown blocker field "${excerpt(key, 60)}"; known fields are ${ALLOWED_BLOCKER_FIELDS.join(', ')}.`,
            suggestion: 'Remove the field, or correct the spelling of the one you meant.',
          })
        }
      }
      if (typeof blocker.summary !== 'string' || blocker.summary.trim().length === 0) {
        run.add({
          pointer: `${pointer}/summary`,
          ruleId: 'blocker-invalid',
          message: 'This blocker has no usable "summary".',
          suggestion: 'Say in one sentence what is blocked and why.',
        })
        continue
      }
      state.blockers += 1
    }
  }

  return buildReport(run, state, limits)
}

function buildReport(run, state, limits) {
  let findings = run.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: run.file,
      pointer: '',
      ruleId: 'too-many-findings',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or fix what is already reported and run again.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const incomplete = run.incomplete || truncated
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      changes: state.changes,
      uncommittedChanges: state.uncommitted,
      carriedChanges: state.carried,
      checks: state.checks,
      checksNotPassing: state.notPassing,
      acceptanceCriteria: state.acceptance,
      blockers: state.blockers,
      credentialMatches: state.credentials,
      transcriptMatches: state.transcripts,
      baseRevisionDeclared: state.baseRevision !== null,
      ageHours: state.ageHours,
      evaluatedAt: state.evaluatedAt,
    },
    findings,
  }
}

/** The JSON report, exactly as it reaches stdout. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 pass, 1 fail, 2 incomplete. An incomplete run is never a pass. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_MARK = Object.freeze({ error: 'ERROR  ', warning: 'WARN   ', info: 'INFO   ' })

/** The human summary. It goes to stderr; stdout carries the JSON and nothing else. */
export function formatReport(report) {
  const summary = report.summary
  const lines = []
  lines.push(`${TOOL_ID}: ${report.status} (evaluated ${summary.evaluatedAt})`)
  lines.push(
    `  ${summary.checked} component(s) checked, ${summary.errors} error(s), ${summary.warnings} warning(s)`,
  )
  lines.push(
    `  ${summary.changes} change(s), ${summary.uncommittedChanges} uncommitted (${summary.carriedChanges} carried), `
    + `${summary.checks} check(s), ${summary.blockers} blocker(s), ${summary.acceptanceCriteria} acceptance criteria`,
  )
  for (const finding of report.findings) {
    const where = finding.location.pointer === '' ? finding.location.file : `${finding.location.file}${finding.location.pointer}`
    lines.push(`  ${SEVERITY_MARK[finding.severity]}${finding.ruleId}  ${where}`)
    lines.push(`         ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}
