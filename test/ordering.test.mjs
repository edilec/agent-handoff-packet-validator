/**
 * Ordering is observable, so it is pinned behaviourally.
 *
 * The inputs are chosen so that code-unit order and ICU collation genuinely
 * disagree about them -- `Z` before `a`, `a-b` before `a_b`, `README` before
 * `assets` -- and the emitted order is asserted exactly. A test whose inputs
 * sort the same way under both orders cannot fail when someone substitutes a
 * collator, which is how this defect reached production twice in this catalog.
 *
 * Scanning the source for `.localeCompare(` would not do it either:
 * `Intl.Collator` produces identical drift with different source text.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compareFindings, createFinding } from '../src/index.mjs'
import { fixture, validPacket, validate, workspace } from './support.mjs'

const UNKNOWN_FIELDS = ['a_b', 'assets', 'Z-item', 'a-item', 'README', 'a-b']
const EXPECTED_POINTERS = ['/README', '/Z-item', '/a-b', '/a-item', '/a_b', '/assets']

test('findings are ordered by pointer in UTF-16 code units, not by collation', async (t) => {
  const dir = await workspace(t)
  const packet = validPacket()
  for (const field of UNKNOWN_FIELDS) packet[field] = 'x'
  await fixture(dir, { packet })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), EXPECTED_POINTERS)
  assert.deepEqual(new Set(report.findings.map((finding) => finding.ruleId)), new Set(['packet-unknown-field']))

  // The inputs really do discriminate: a collator disagrees with all of it.
  const collated = [...UNKNOWN_FIELDS].sort(new Intl.Collator('en').compare).map((field) => `/${field}`)
  assert.notDeepEqual(collated, EXPECTED_POINTERS)
})

test('pointers compare as strings, so /changes/10 precedes /changes/9', async (t) => {
  const dir = await workspace(t)
  const changes = []
  for (let index = 0; index < 11; index += 1) {
    changes.push({ path: `src/file-${index}.mjs`, status: 'modified', committed: true })
  }
  changes[9].path = '../nine.mjs'
  changes[10].path = '../ten.mjs'
  await fixture(dir, { packet: validPacket({ changes }) })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/changes/10/path',
    '/changes/9/path',
  ])

  // Emission order was 9 then 10; sorting is what put them here.
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['change-path-invalid', 'change-path-invalid'])
})

test('two findings at one pointer are ordered by rule id, then by message', () => {
  const file = 'handoff.json'
  const pointer = '/checks/0'
  const rows = [
    createFinding({ file, pointer, ruleId: 'credential-in-packet', message: 'b' }),
    createFinding({ file, pointer, ruleId: 'check-invalid', message: 'z' }),
    createFinding({ file, pointer, ruleId: 'credential-in-packet', message: 'a' }),
  ]
  assert.deepEqual(
    [...rows].sort(compareFindings).map((finding) => `${finding.ruleId}:${finding.message}`),
    ['check-invalid:z', 'credential-in-packet:a', 'credential-in-packet:b'],
  )
})
