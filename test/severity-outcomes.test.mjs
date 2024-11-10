/**
 * Severity, pinned behaviourally, one case per rule in the table.
 *
 * Every case writes a real packet, runs the real CLI and asserts the emitted
 * severity word, the report status and the process exit code, with the expected
 * values written as literals at the assertion site.
 *
 * This is deliberately not a comparison between the severity table, the rule
 * documentation and a map of expectations: those are three declarations, and
 * one coordinated edit satisfies all three. An exit code cannot be edited at
 * all. Demote any error rule here and its case fails on the exit code.
 */

import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, checkHandoffPacket, exitCodeFor } from '../src/index.mjs'
import { BASE_REVISION, NOW, OTHER_REVISION, fixture, run, validPacket, workspace } from './support.mjs'

const without = (field) => {
  const packet = validPacket()
  delete packet[field]
  return packet
}

const CASES = [
  { ruleId: 'acceptance-empty', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ acceptance: [] }) },
  { ruleId: 'acceptance-invalid', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ acceptance: ['  '] }) },
  { ruleId: 'acceptance-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('acceptance') },
  { ruleId: 'base-revision-invalid', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ baseRevision: 'main' }) },
  { ruleId: 'base-revision-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('baseRevision') },
  { ruleId: 'blocker-invalid', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ blockers: ['just a string'] }) },
  { ruleId: 'blockers-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('blockers') },
  {
    ruleId: 'carried-in-invalid',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({ changes: [{ path: 'src/a.mjs', status: 'added', committed: false, carriedIn: '/tmp/p.patch' }] }),
  },
  {
    ruleId: 'carried-in-on-committed-change',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    packet: () => validPacket({ changes: [{ path: 'src/a.mjs', status: 'added', committed: true, carriedIn: 'patches/0001.patch' }] }),
  },
  {
    ruleId: 'change-committed-unknown',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({ changes: [{ path: 'src/a.mjs', status: 'added' }] }),
  },
  { ruleId: 'change-invalid', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ changes: ['src/a.mjs'] }) },
  {
    ruleId: 'change-path-duplicate',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({
      changes: [
        { path: 'src/a.mjs', status: 'added', committed: true },
        { path: 'src/a.mjs', status: 'modified', committed: true },
      ],
    }),
  },
  {
    ruleId: 'change-path-invalid',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({ changes: [{ path: '../outside.mjs', status: 'added', committed: true }] }),
  },
  { ruleId: 'changes-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('changes') },
  {
    ruleId: 'check-excludes-uncommitted',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    packet: () => validPacket({
      changes: [{ path: 'src/a.mjs', status: 'added', committed: false, carriedIn: 'patches/0001.patch' }],
    }),
  },
  { ruleId: 'check-invalid', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ checks: ['npm test'] }) },
  {
    ruleId: 'check-not-passing',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    packet: () => validPacket({ checks: [{ name: 'unit', command: 'npm test', result: 'fail', revision: BASE_REVISION }] }),
  },
  {
    ruleId: 'check-revision-mismatch',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    packet: () => validPacket({ checks: [{ name: 'unit', command: 'npm test', result: 'pass', revision: OTHER_REVISION }] }),
  },
  {
    ruleId: 'check-revision-missing',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({ checks: [{ name: 'unit', command: 'npm test', result: 'pass' }] }),
  },
  { ruleId: 'checks-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('checks') },
  {
    ruleId: 'credential-in-packet',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({ nextAction: 'Run it with AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE set.' }),
  },
  { ruleId: 'field-too-long', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ objective: 'x'.repeat(2500) }) },
  {
    ruleId: 'generated-in-future',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    packet: () => validPacket({ generated: '2026-09-15T09:30:00Z' }),
  },
  { ruleId: 'generated-invalid', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ generated: '2026-09-14 09:30' }) },
  { ruleId: 'generated-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('generated') },
  { ruleId: 'input-not-json', severity: 'error', status: 'incomplete', exit: 2, raw: '{ "objective": ' },
  { ruleId: 'input-not-utf8', severity: 'error', status: 'incomplete', exit: 2, raw: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) },
  {
    ruleId: 'input-too-large',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    packet: () => validPacket(),
    args: ['--max-document-bytes', '64'],
  },
  {
    ruleId: 'input-unreadable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    packet: () => validPacket(),
    args: ['--packet', 'absent.json'],
  },
  { ruleId: 'next-action-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('nextAction') },
  { ruleId: 'no-changes-declared', severity: 'warning', status: 'pass', exit: 0, packet: () => validPacket({ changes: [] }) },
  { ruleId: 'no-checks-declared', severity: 'warning', status: 'pass', exit: 0, packet: () => validPacket({ checks: [] }) },
  { ruleId: 'objective-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('objective') },
  { ruleId: 'packet-invalid', severity: 'error', status: 'fail', exit: 1, raw: '[]' },
  { ruleId: 'packet-stale', severity: 'warning', status: 'pass', exit: 0, packet: () => validPacket({ generated: '2026-09-01T09:30:00Z' }) },
  {
    ruleId: 'packet-too-deep',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    packet: () => validPacket(),
    args: ['--max-depth', '2'],
  },
  { ruleId: 'packet-unknown-field', severity: 'error', status: 'fail', exit: 1, packet: () => validPacket({ notes: 'extra' }) },
  {
    ruleId: 'path-escapes-root',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    setup: async (dir) => {
      const root = join(dir, 'root')
      await mkdir(root, { recursive: true })
      await writeFile(join(dir, 'outside.json'), JSON.stringify(validPacket()))
      await symlink(join(dir, 'outside.json'), join(root, 'handoff.json'))
      return { root }
    },
  },
  { ruleId: 'repository-missing', severity: 'error', status: 'fail', exit: 1, packet: () => without('repository') },
  {
    ruleId: 'schema-version-unsupported',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    packet: () => validPacket({ schemaVersion: '2' }),
  },
  {
    ruleId: 'too-many-entries',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    packet: () => validPacket({
      changes: [
        { path: 'src/a.mjs', status: 'added', committed: true },
        { path: 'src/b.mjs', status: 'added', committed: true },
      ],
    }),
    args: ['--max-entries', '1'],
  },
  {
    ruleId: 'too-many-findings',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    packet: () => {
      const packet = validPacket()
      delete packet.objective
      delete packet.repository
      return packet
    },
    args: ['--max-findings', '1'],
  },
  {
    ruleId: 'too-many-nodes',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    packet: () => validPacket(),
    args: ['--max-nodes', '5'],
  },
  {
    ruleId: 'transcript-embedded',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({
      nextAction: ['user: a', 'assistant: b', 'user: c', 'assistant: d', 'user: e', 'assistant: f'].join('\n'),
    }),
  },
  {
    ruleId: 'uncommitted-change-unreachable',
    severity: 'error',
    status: 'fail',
    exit: 1,
    packet: () => validPacket({ changes: [{ path: 'src/a.mjs', status: 'added', committed: false }] }),
  },
]

for (const entry of CASES) {
  test(`${entry.ruleId} is ${entry.severity} and exits ${entry.exit}`, async (t) => {
    const dir = await workspace(t)
    let root = dir
    if (entry.setup !== undefined) {
      ({ root } = await entry.setup(dir))
    } else if (entry.raw !== undefined) {
      await fixture(dir, { raw: entry.raw })
    } else {
      await fixture(dir, { packet: entry.packet() })
    }

    const result = await run(['--root', root, '--now', NOW, ...(entry.args ?? [])])
    const report = JSON.parse(result.stdout)
    const finding = report.findings.find((row) => row.ruleId === entry.ruleId)
    assert.ok(
      finding !== undefined,
      `expected a ${entry.ruleId} finding, got ${report.findings.map((row) => row.ruleId).join(', ')}`,
    )
    assert.equal(finding.severity, entry.severity)
    assert.equal(report.status, entry.status)
    assert.equal(result.code, entry.exit)
  })
}

test('the time budget is an error that stops the run, checked with an injected clock', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({
      changes: [
        { path: 'src/a.mjs', status: 'added', committed: true },
        { path: 'src/b.mjs', status: 'added', committed: true },
        { path: 'src/c.mjs', status: 'added', committed: true },
      ],
    }),
  })

  let ticks = 0
  const report = await checkHandoffPacket({
    root: dir,
    now: Date.UTC(2026, 8, 14, 12),
    limits: { maxRuntimeMs: 5 },
    // Monotonic time jumps 4 ms per reading: the first entry is inside the
    // budget and the second is not.
    monotonic: () => { ticks += 4; return ticks },
  })

  const finding = report.findings.find((row) => row.ruleId === 'time-budget-exceeded')
  assert.ok(finding !== undefined)
  assert.equal(finding.severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.match(finding.message, /A partial pass is not a pass/)
})

test('every rule in the table has a case that drives it through the CLI or the API', () => {
  const covered = new Set(CASES.map((entry) => entry.ruleId))
  covered.add('time-budget-exceeded')
  const missing = Object.keys(RULE_SEVERITY).filter((ruleId) => !covered.has(ruleId))
  assert.deepEqual(missing, [], 'every rule needs a behavioural case')
})
