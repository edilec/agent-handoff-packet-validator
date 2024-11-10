/**
 * Two runs over the same inputs produce byte-identical stdout, and the one
 * input that would otherwise vary -- the instant -- is injected and recorded.
 */

import assert from 'node:assert/strict'
import process from 'node:process'
import test from 'node:test'

import { checkHandoffPacket } from '../src/index.mjs'
import { BASE_REVISION, NOW, fixture, run, validPacket, workspace } from './support.mjs'

test('the same inputs produce byte-identical stdout', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({
      generated: '2026-09-01T09:30:00Z',
      changes: [
        { path: 'src/b.mjs', status: 'modified', committed: true },
        { path: 'src/a.mjs', status: 'added', committed: false },
      ],
      checks: [{ name: 'unit', command: 'npm test', result: 'fail', revision: BASE_REVISION }],
      blockers: [{ summary: 'The staging queue is full.', owner: 'platform' }],
    }),
  })

  const first = await run(['--root', dir, '--now', NOW])
  const second = await run(['--root', dir, '--now', NOW])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.equal(first.stderr, second.stderr)
})

test('the evaluation instant comes from an injected clock and decides staleness', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket({ generated: '2026-09-14T00:00:00Z' }) })

  const atTheThreshold = await checkHandoffPacket({ root: dir, now: () => Date.UTC(2026, 8, 17, 0) })
  assert.equal(atTheThreshold.summary.ageHours, 72)
  assert.equal(atTheThreshold.status, 'pass')

  const oneHourLater = await checkHandoffPacket({ root: dir, now: () => Date.UTC(2026, 8, 17, 1) })
  assert.equal(oneHourLater.summary.ageHours, 73)
  assert.ok(oneHourLater.findings.some((finding) => finding.ruleId === 'packet-stale'))
  assert.equal(oneHourLater.summary.evaluatedAt, '2026-09-17T01:00:00Z')
})

test('the report carries no host path and no clock this run did not name', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })
  const result = await run(['--root', dir, '--now', NOW])
  const report = JSON.parse(result.stdout)

  assert.ok(!result.stdout.includes(dir))
  assert.ok(!result.stdout.includes(process.cwd()))
  assert.equal(report.summary.evaluatedAt, NOW)
  // Every clock time in the report is one this run was handed: the injected
  // evaluation instant, or the packet's own "generated". Nothing is read from
  // the host clock and nothing is stamped on the way out.
  const times = new Set(result.stdout.match(/\d{2}:\d{2}:\d{2}/g) ?? [])
  assert.ok(times.has('12:00:00'), 'the injected instant is recorded')
  for (const time of times) {
    assert.ok(['12:00:00', '09:30:00'].includes(time), `an unexpected time reached the report: ${time}`)
  }
})
