/**
 * Unknown is never a pass, and the line between "fail" and "incomplete" is
 * where this tool says it is.
 *
 * A field the packet omits is a fact ABOUT the packet: the run read everything
 * it was given, and the verdict is `fail`. A document that could not be read,
 * decoded, parsed or walked is evidence the run did not obtain: `incomplete`,
 * exit 2, never a pass, and never reported as absence.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { NOW, findingFor, fixture, run, validPacket, validate, workspace } from './support.mjs'

const UNOBTAINED = [
  { name: 'a packet that is not there', args: ['--packet', 'absent.json'], ruleId: 'input-unreadable', packet: validPacket() },
  { name: 'a packet that is not UTF-8', raw: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), ruleId: 'input-not-utf8' },
  { name: 'a packet that does not parse', raw: '{ "objective": ', ruleId: 'input-not-json' },
  { name: 'a packet past the size limit', args: ['--max-document-bytes', '64'], ruleId: 'input-too-large', packet: validPacket() },
  { name: 'a packet too deep to walk', args: ['--max-depth', '2'], ruleId: 'packet-too-deep', packet: validPacket() },
  { name: 'a packet with more values than the node limit', args: ['--max-nodes', '5'], ruleId: 'too-many-nodes', packet: validPacket() },
  { name: 'a schema version this build does not understand', ruleId: 'schema-version-unsupported', packet: validPacket({ schemaVersion: '9' }) },
]

for (const entry of UNOBTAINED) {
  test(`${entry.name} is incomplete, not a pass and not a partial verdict`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, entry.raw === undefined ? { packet: entry.packet } : { raw: entry.raw })
    const result = await run(['--root', dir, '--now', NOW, ...(entry.args ?? [])])
    const report = JSON.parse(result.stdout)

    assert.equal(report.status, 'incomplete')
    assert.equal(result.code, 2)
    const finding = report.findings.find((row) => row.ruleId === entry.ruleId)
    assert.ok(finding !== undefined, `expected ${entry.ruleId}, got ${report.findings.map((row) => row.ruleId).join(', ')}`)

    // The incomplete flag is one defence and the error severity is the other:
    // deleting the flag drops the run to "fail", never to "pass", and changes
    // the exit code from 2 to 1 -- which is what the flag's own test catches.
    assert.equal(finding.severity, 'error')
    assert.ok(report.summary.errors > 0)
    assert.equal(report.summary.checked, 0, 'nothing was examined, and the summary says so')
  })
}

test('a packet that omits a field fails: the tool read it, and it is wrong', async (t) => {
  const dir = await workspace(t)
  const packet = validPacket()
  delete packet.baseRevision
  await fixture(dir, { packet })

  const { code, report } = await validate(dir)
  assert.equal(report.status, 'fail')
  assert.equal(code, 1)
  assert.ok(report.summary.checked > 0)
})

test('an unreadable packet does not report the absence of anything', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })
  const { code, report } = await validate(dir, ['--packet', 'absent.json'])

  assert.equal(code, 2)
  const finding = findingFor(report, 'input-unreadable')
  assert.match(finding.message, /could not be read/)
  // "No base revision was supplied" would be false: the packet was never read,
  // so nothing is known about what it supplies.
  assert.deepEqual(report.findings.map((row) => row.ruleId), ['input-unreadable'])
  assert.equal(report.summary.baseRevisionDeclared, false)
  assert.equal(report.summary.changes, 0)
})

test('a truncated report is incomplete rather than a shorter list of findings', async (t) => {
  const dir = await workspace(t)
  const packet = validPacket()
  delete packet.objective
  delete packet.repository
  delete packet.nextAction
  await fixture(dir, { packet })

  const full = await validate(dir)
  assert.equal(full.code, 1)
  assert.equal(full.report.findings.length, 3)

  const truncated = await validate(dir, ['--max-findings', '2'])
  assert.equal(truncated.code, 2)
  assert.equal(truncated.report.status, 'incomplete')
  const finding = findingFor(truncated.report, 'too-many-findings')
  assert.match(finding.message, /2 were not reported and this report is partial/)
})
