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

/**
 * "In every outcome" is the claim, so every outcome is here.
 *
 * The body used to run one passing fixture twice. That left the three report
 * statuses the tool can reach uncovered, and it left the outcomes where stdout
 * is deliberately NOT JSON -- the empty stream a configuration error owes, and
 * the plain text of --help and --version -- looking like cases the name had
 * quietly excluded. Both halves of the contract are asserted here: a run with a
 * subject writes a parseable report and nothing else, and a run that never had
 * one writes nothing at all.
 */
test('stdout is parseable JSON in every outcome that produces a report, and empty in every one that does not', async (t) => {
  const dir = await workspace(t)

  const reported = [
    { name: 'pass', exit: 0, status: 'pass', packet: validPacket() },
    { name: 'fail', exit: 1, status: 'fail', packet: validPacket({ objective: '' }) },
    { name: 'incomplete', exit: 2, status: 'incomplete', packet: validPacket({ schemaVersion: '2' }) },
    { name: 'unparseable input', exit: 2, status: 'incomplete', raw: '{ not json' },
  ]

  for (const outcome of reported) {
    await fixture(dir, outcome.raw === undefined ? { packet: outcome.packet } : { raw: outcome.raw })
    const result = await run(['--root', dir, '--now', NOW])

    assert.equal(result.code, outcome.exit, `the ${outcome.name} outcome exited ${result.code}`)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, outcome.status)
    assert.equal(`${JSON.stringify(report, null, 2)}\n`, result.stdout, `stdout carried something besides the ${outcome.name} report`)
  }

  const silent = [
    { name: 'an unknown option', args: ['--nonsense'] },
    { name: 'a missing root', args: ['--now', NOW] },
    { name: 'an unreadable root', args: ['--root', join(dir, 'absent'), '--now', NOW] },
  ]

  for (const outcome of silent) {
    const result = await run(outcome.args)
    assert.equal(result.code, 2, `${outcome.name} did not exit 2`)
    assert.equal(result.stdout, '', `${outcome.name} wrote a report for a run that never had a subject`)
    assert.ok(result.stderr.trim().length > 0, `${outcome.name} said nothing on stderr either`)
  }

  for (const flag of ['--help', '--version']) {
    const result = await run([flag])
    assert.equal(result.code, 0)
    assert.throws(() => JSON.parse(result.stdout), `${flag} started emitting JSON; the report contract does not cover it`)
  }
})

test('--json silences the human summary and changes nothing on stdout', async (t) => {
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
