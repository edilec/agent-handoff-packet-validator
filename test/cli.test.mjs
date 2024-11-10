/**
 * The command line surface: help, version, the two shapes of exit 2, and the
 * promise that stdout carries the JSON report and nothing else.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { NOW, fixture, run, validPacket, workspace } from './support.mjs'

test('--help states the required fields, the streams and the exit codes, and exits 0', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /Required fields: acceptance, baseRevision, blockers, changes, checks, generated, nextAction, objective, repository\./)
  assert.match(result.stdout, /stdout {2}the JSON report only/)
  assert.match(result.stdout, /Runs no git command/)
  assert.match(result.stdout, /Exit codes/)
  assert.match(result.stdout, /It does NOT mean the\n {2}revision exists/)
})

test('--version prints a version and exits 0', async () => {
  const result = await run(['--version'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/)
})

test('an unknown option is refused, with the help on stderr and nothing on stdout', async () => {
  const result = await run(['--roooot', '/tmp'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--roooot"/)
})

test('a repeated flag is a configuration error, not a silent last-wins', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })
  const result = await run(['--root', dir, '--now', NOW, '--now', '2020-01-01T00:00:00Z'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--now was given more than once/)
})

test('--root is required and an unusable one is a configuration error', async (t) => {
  const withoutRoot = await run(['--now', NOW])
  assert.equal(withoutRoot.code, 2)
  assert.equal(withoutRoot.stdout, '')
  assert.match(withoutRoot.stderr, /--root is required/)

  const dir = await workspace(t)
  const missing = await run(['--root', join(dir, 'absent')])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /root is not a readable directory/)
})

test('stdout is parseable JSON in every outcome, and --json silences the summary', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })

  const human = await run(['--root', dir, '--now', NOW])
  assert.equal(human.code, 0)
  assert.doesNotThrow(() => JSON.parse(human.stdout))
  assert.match(human.stderr, /agent-handoff-packet-validator: pass/)

  const machine = await run(['--root', dir, '--now', NOW, '--json'])
  assert.equal(machine.code, 0)
  assert.equal(machine.stdout, human.stdout)
  assert.ok(!machine.stderr.includes('agent-handoff-packet-validator: pass'))
})

test('without --now the evaluation instant is stated on stderr and recorded in the report', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket({ generated: '2020-01-01T00:00:00Z' }) })
  const result = await run(['--root', dir])
  const report = JSON.parse(result.stdout)

  assert.match(result.stderr, /taken from this host's clock/)
  assert.match(report.summary.evaluatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  assert.ok(result.stderr.includes(report.summary.evaluatedAt))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'packet-stale'))
})

test('a malformed --now is a configuration error, not a silently ignored one', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })
  const result = await run(['--root', dir, '--now', '14-09-2026'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--now must be a UTC instant/)
})
