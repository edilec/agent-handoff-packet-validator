/** The packet predicates: revisions, instants and paths, all clock-free. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluationInstant, formatInstant, hourDifference, isFullRevision, isUsablePath, parseInstant,
} from '../src/index.mjs'

test('a base revision is a full 40-character lowercase hex name', () => {
  assert.equal(isFullRevision('3f9a2c1d4e5b6a7c8d9e0f1a2b3c4d5e6f708192'), true)
  assert.equal(isFullRevision('3F9A2C1D4E5B6A7C8D9E0F1A2B3C4D5E6F708192'), false)
  assert.equal(isFullRevision('3f9a2c1'), false)
  assert.equal(isFullRevision('main'), false)
  assert.equal(isFullRevision(''), false)
  assert.equal(isFullRevision(null), false)
  assert.equal(isFullRevision('3f9a2c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7081920'), false)
})

test('instants are parsed strictly, in UTC, and a missing zone is refused', () => {
  assert.equal(parseInstant('2026-09-14T09:30:00Z').ms, Date.UTC(2026, 8, 14, 9, 30, 0))
  assert.equal(parseInstant('2026-09-14T09:30:00.250Z').ms, Date.UTC(2026, 8, 14, 9, 30, 0, 250))
  assert.equal(parseInstant('2026-09-14T09:30:00').ok, false, 'a local-time instant means a different moment on each machine')
  assert.equal(parseInstant('2026-09-14T09:30:00+05:30').ok, false)
  assert.equal(parseInstant('2026-02-30T00:00:00Z').ok, false)
  assert.equal(parseInstant('2026-09-14').ok, false)
  assert.equal(parseInstant(1789012345678).ok, false)
  assert.equal(parseInstant('2024-02-29T00:00:00Z').ok, true, 'a leap day is a real date')
})

test('hours are whole and signed', () => {
  assert.equal(hourDifference(Date.UTC(2026, 8, 14, 0), Date.UTC(2026, 8, 14, 5)), 5)
  assert.equal(hourDifference(Date.UTC(2026, 8, 14, 0), Date.UTC(2026, 8, 14, 5, 59)), 5)
  assert.equal(hourDifference(Date.UTC(2026, 8, 14, 5), Date.UTC(2026, 8, 14, 0)), -5)
})

test('the evaluation instant comes from an injected clock', () => {
  assert.deepEqual(evaluationInstant(() => Date.UTC(2026, 8, 14, 12)), {
    ms: Date.UTC(2026, 8, 14, 12),
    iso: '2026-09-14T12:00:00Z',
  })
  assert.equal(evaluationInstant(Date.UTC(2026, 0, 1)).iso, '2026-01-01T00:00:00Z')
  assert.equal(formatInstant(Date.UTC(2026, 11, 31, 23, 59, 59)), '2026-12-31T23:59:59Z')
  assert.throws(() => evaluationInstant(() => Number.NaN), /usable instant/)
})

test('a changed path is relative, escapes nothing and carries no control character', () => {
  assert.equal(isUsablePath('src/upload.mjs'), true)
  assert.equal(isUsablePath('docs/retry policy.md'), true)
  assert.equal(isUsablePath('../outside.mjs'), false)
  assert.equal(isUsablePath('a/../b'), false)
  assert.equal(isUsablePath('/etc/passwd'), false)
  assert.equal(isUsablePath('C:\\Windows\\System32'), false)
  assert.equal(isUsablePath('src//upload.mjs'), false)
  assert.equal(isUsablePath(`src/upload${String.fromCharCode(0x0a)}.mjs`), false)
  assert.equal(isUsablePath(`src/upload${String.fromCharCode(0x202e)}.mjs`), false)
  assert.equal(isUsablePath(''), false)
  assert.equal(isUsablePath('x'.repeat(401)), false)
})
