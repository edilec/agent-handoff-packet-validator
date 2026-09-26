/**
 * The shape of a handoff packet, and the predicates that decide whether one
 * member of it is usable.
 *
 * Everything here is a pure function of its arguments. The clock arrives as an
 * argument; nothing reads one.
 *
 * The packet answers eight questions a successor cannot start without: what is
 * the objective, which repository, which base revision, what has changed, what
 * would count as done, what has been checked, what is blocked, and what is the
 * next action. A field the packet omits is a fact about the packet -- not a
 * fact this run failed to obtain -- so an absent field is a failure, while an
 * unreadable document is an incomplete run. That line is drawn once, here, and
 * the README states it.
 */

import { hasForbiddenCharacter } from './text.mjs'

/** Members a packet may carry. Anything else is a typo or a smuggled field. */
export const ALLOWED_PACKET_FIELDS = Object.freeze([
  'acceptance', 'baseRevision', 'blockers', 'branch', 'changes', 'checks',
  'generated', 'nextAction', 'objective', 'repository', 'schemaVersion',
])

/** Members a packet must carry. `branch` and `schemaVersion` are optional. */
export const REQUIRED_PACKET_FIELDS = Object.freeze([
  'acceptance', 'baseRevision', 'blockers', 'changes', 'checks',
  'generated', 'nextAction', 'objective', 'repository',
])

export const ALLOWED_CHANGE_FIELDS = Object.freeze(['carriedIn', 'committed', 'note', 'path', 'status'])
export const ALLOWED_CHECK_FIELDS = Object.freeze(['command', 'includesUncommitted', 'name', 'result', 'revision'])
export const ALLOWED_BLOCKER_FIELDS = Object.freeze(['detail', 'owner', 'summary'])

export const CHANGE_STATUSES = Object.freeze(['added', 'deleted', 'modified', 'renamed'])
export const CHECK_RESULTS = Object.freeze(['fail', 'pass', 'skipped'])

const FULL_REVISION = /^[0-9a-f]{40}$/
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/
const MS_PER_HOUR = 3600000

/**
 * A base revision is a full 40-character lowercase hexadecimal object name.
 *
 * A branch name moves, and an abbreviated revision is ambiguous in a repository
 * that has grown since the packet was written. The successor needs a name that
 * still means the same commit tomorrow, so anything else is refused rather than
 * accepted with a warning.
 */
export function isFullRevision(value) {
  return typeof value === 'string' && FULL_REVISION.test(value)
}

/**
 * Parse a strict UTC instant, `YYYY-MM-DDTHH:MM:SSZ` with optional
 * milliseconds.
 *
 * `Date.parse` accepts far more than that and differs between engines over what
 * it does with a missing offset -- some read it as local time -- which would
 * make a packet's age depend on the machine judging it. The round-trip check
 * also rejects 30 February, which a lenient parser reads as 2 March.
 */
export function parseInstant(value) {
  if (typeof value !== 'string') return { ok: false }
  const match = INSTANT.exec(value)
  if (match === null) return { ok: false }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const milliseconds = match[7] === undefined ? 0 : Math.round(Number(match[7]) * 1000)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return { ok: false }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds)
  const date = new Date(ms)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false }
  }
  return { ok: true, ms }
}

/** Whole hours between two instants. Negative when `laterMs` precedes `earlierMs`. */
export function hourDifference(earlierMs, laterMs) {
  return Math.floor((laterMs - earlierMs) / MS_PER_HOUR)
}

/** Render an instant as the strict UTC form this tool reads and reports. */
export function formatInstant(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) throw new TypeError('The clock did not produce a usable instant')
  return `${date.toISOString().slice(0, 19)}Z`
}

/**
 * The evaluation instant, from an injected clock.
 *
 * The clock is an argument with a default, never an unconditional read: a test
 * steps it past the staleness threshold, and a caller that wants a fixed
 * evaluation instant passes one.
 */
export function evaluationInstant(now = Date.now) {
  const ms = typeof now === 'function' ? now() : now
  if (!Number.isFinite(ms)) throw new TypeError('The clock did not produce a usable instant')
  return { ms, iso: formatInstant(ms) }
}

/**
 * A changed path, as a packet may state it.
 *
 * Relative, no `..` segment, no leading slash, no drive letter, no NUL or other
 * control. This is a check on what the packet *says*, not confinement of
 * anything this tool opens -- the validator never opens a changed file, and the
 * README says so. It matters because the successor will, and a packet that
 * names `../../etc/passwd` as a changed file is either wrong or hostile.
 */
export function isUsablePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) return false
  if (hasForbiddenCharacter(value)) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) return false
  const segments = value.split(/[\\/]/)
  if (segments.includes('..') || segments.includes('')) return false
  return true
}
