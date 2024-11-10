/**
 * The acceptance criteria, driven through the real CLI:
 *
 *   1. A missing base revision fails.
 *   2. A unique uncommitted file reference fails.
 *   3. Packets do not embed credentials.
 *   4. Packets do not embed entire transcripts.
 *
 * Every assertion is about emitted output and exit codes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASE_REVISION, OTHER_REVISION, findingFor, fixture, ruleIds, validPacket, validate, workspace,
} from './support.mjs'

test('the baseline packet passes, so every other case changes exactly one thing', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })
  const { code, report } = await validate(dir)

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.baseRevisionDeclared, true)
  assert.ok(report.summary.checked >= 9, 'a parsed packet always examines the nine required fields')
})

test('a missing base revision fails', async (t) => {
  const dir = await workspace(t)
  const packet = validPacket()
  delete packet.baseRevision
  await fixture(dir, { packet })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  const finding = findingFor(report, 'base-revision-missing')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/baseRevision')
  assert.equal(report.summary.baseRevisionDeclared, false)
})

test('a base revision that is a branch name or an abbreviation fails', async (t) => {
  for (const value of ['main', '3f9a2c1', BASE_REVISION.toUpperCase(), `${BASE_REVISION}0`]) {
    const dir = await workspace(t)
    await fixture(dir, { packet: validPacket({ baseRevision: value }) })
    const { code, report } = await validate(dir)

    assert.equal(code, 1, `expected "${value}" to fail`)
    const finding = findingFor(report, 'base-revision-invalid')
    assert.equal(finding.severity, 'error')
    assert.match(finding.message, /40-character lowercase hexadecimal/)
    assert.equal(report.summary.baseRevisionDeclared, false)
  }
})

test('a uniquely uncommitted file with nothing carrying it fails', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({
      changes: [
        { path: 'src/upload.mjs', status: 'modified', committed: true },
        { path: 'src/retry.mjs', status: 'added', committed: false },
      ],
    }),
  })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  const finding = findingFor(report, 'uncommitted-change-unreachable')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/changes/1')
  assert.match(finding.message, /only in the sender's working tree/)
  assert.equal(report.summary.uncommittedChanges, 1)
  assert.equal(report.summary.carriedChanges, 0)
})

test('the same uncommitted file passes once something carries it', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({
      changes: [
        { path: 'src/upload.mjs', status: 'modified', committed: true },
        { path: 'src/retry.mjs', status: 'added', committed: false, carriedIn: 'patches/0001.patch' },
      ],
      checks: [{ name: 'unit', command: 'npm test', result: 'pass', revision: BASE_REVISION, includesUncommitted: true }],
    }),
  })

  const { code, report } = await validate(dir)
  assert.equal(code, 0, `expected a pass, got ${ruleIds(report).join(', ')}`)
  assert.equal(report.summary.uncommittedChanges, 1)
  assert.equal(report.summary.carriedChanges, 1)
})

test('a change that does not say whether it is committed is not assumed committed', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({ changes: [{ path: 'src/upload.mjs', status: 'modified' }] }),
  })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  const finding = findingFor(report, 'change-committed-unknown')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /An absent flag is not "committed"/)
})

test('a credential in the packet fails, and never reaches either stream', async (t) => {
  const dir = await workspace(t)
  // AWS publishes this key id as its documentation example. It authenticates
  // nothing and it is the value this catalog's contract uses for the same test.
  const credential = 'AKIAIOSFODNN7EXAMPLE'
  await fixture(dir, {
    packet: validPacket({
      checks: [{
        name: 'unit',
        command: `AWS_ACCESS_KEY_ID=${credential} npm test`,
        result: 'pass',
        revision: BASE_REVISION,
      }],
    }),
  })

  const { code, report, stdout, stderr } = await validate(dir)
  assert.equal(code, 1)
  const finding = findingFor(report, 'credential-in-packet')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/checks/0/command')
  assert.match(finding.evidence, /aws-access-key-id matched 20 characters at offset \d+/)
  assert.match(finding.evidence, /the value is not reproduced/)

  assert.ok(!stdout.includes(credential), 'the credential reached stdout')
  assert.ok(!stderr.includes(credential), 'the credential reached stderr')
  assert.ok(!stdout.includes('AKIA'), 'part of the credential reached stdout')
  assert.equal(report.summary.credentialMatches, 1)
})

test('a credential anywhere in the packet is found, including in a field this build does not know', async (t) => {
  const dir = await workspace(t)
  const token = `ghp_${'a'.repeat(36)}`
  const packet = validPacket()
  packet.scratchpad = { note: `authorization: bearer ${token}` }
  await fixture(dir, { packet })

  const { code, report, stdout } = await validate(dir)
  assert.equal(code, 1)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'credential-in-packet'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'packet-unknown-field'))
  assert.ok(!stdout.includes(token))
})

test('an embedded transcript fails', async (t) => {
  const dir = await workspace(t)
  const transcript = [
    'user: can you finish the retry work?',
    'assistant: I started on it.',
    'user: what is left?',
    'assistant: the backoff constant.',
    'user: ok',
    'assistant: handing over.',
  ].join('\n')
  await fixture(dir, { packet: validPacket({ nextAction: transcript }) })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  const finding = findingFor(report, 'transcript-embedded')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/nextAction')
  assert.match(finding.message, /6 conversational turns/)
  assert.equal(report.summary.transcriptMatches, 1)
})

test('a wall of text in one field fails even with no speaker labels', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket({ objective: 'x'.repeat(2500) }) })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  const finding = findingFor(report, 'field-too-long')
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /2500 characters, past the maxFieldChars threshold of 2000/)
})

test('a check that ran somewhere else is reported against the base revision', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({
      checks: [{ name: 'unit', command: 'npm test', result: 'pass', revision: OTHER_REVISION }],
    }),
  })

  const { code, report } = await validate(dir)
  assert.equal(code, 0)
  const finding = findingFor(report, 'check-revision-mismatch')
  assert.equal(finding.severity, 'warning')
  assert.match(finding.evidence, /check revision a1b2c3d4e5f6\.\.\., base revision 3f9a2c1d4e5b\.\.\./)
})
