/**
 * What the packet must not carry, and the discipline that makes the check safe:
 * the matched text never leaves the scanner.
 *
 * Every value below is synthetic. The AWS key id is the one AWS publishes as
 * its documentation example and the one this catalog's contract uses; the rest
 * are the right shape and authenticate nothing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CREDENTIAL_PATTERNS, countTranscriptTurns, findCredentials, redactCredentials, walkStrings,
} from '../src/index.mjs'
import { NOW, fixture, run, validPacket, workspace } from './support.mjs'

const SAMPLES = [
  { id: 'aws-access-key-id', value: 'AKIAIOSFODNN7EXAMPLE' },
  { id: 'private-key-block', value: '-----BEGIN RSA PRIVATE KEY-----' },
  { id: 'github-token', value: `ghp_${'a'.repeat(36)}` },
  { id: 'github-fine-grained-token', value: `github_pat_${'B'.repeat(24)}` },
  { id: 'slack-token', value: 'xoxb-1234567890-abcdefghij' },
  { id: 'google-api-key', value: `AIza${'c'.repeat(35)}` },
  { id: 'npm-token', value: `npm_${'d'.repeat(36)}` },
  { id: 'json-web-token', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.ZmFrZXNpZ24' },
  { id: 'authorization-header', value: 'Authorization: Bearer abc123def456ghi' },
  { id: 'secret-assignment', value: 'client_secret=hunter2hunter2' },
]

test('every documented pattern has a sample that matches it', () => {
  for (const sample of SAMPLES) {
    const hits = findCredentials(`prefix ${sample.value} suffix`)
    assert.ok(
      hits.some((hit) => hit.id === sample.id),
      `${sample.id} did not match its own sample; hits were ${hits.map((hit) => hit.id).join(', ') || 'none'}`,
    )
  }
  assert.equal(SAMPLES.length, CREDENTIAL_PATTERNS.length, 'every pattern needs a sample')
})

test('a hit carries the pattern, the offset and the length, and never the text', () => {
  const hits = findCredentials('run with AKIAIOSFODNN7EXAMPLE now')
  assert.deepEqual(hits, [{ id: 'aws-access-key-id', index: 9, length: 20 }])
  for (const hit of hits) {
    for (const value of Object.values(hit)) {
      assert.ok(typeof value !== 'string' || !value.includes('AKIA'))
    }
  }
})

test('ordinary packet prose matches nothing', () => {
  const clean = [
    'npm test', 'Wire the backoff constant into the worker configuration.',
    'services/export-worker', '3f9a2c1d4e5b6a7c8d9e0f1a2b3c4d5e6f708192',
    'The retry policy document is not committed yet.',
  ]
  for (const value of clean) assert.deepEqual(findCredentials(value), [])
})

test('turn counting sees speaker labels and ignores prose', () => {
  assert.equal(countTranscriptTurns('user: a\nassistant: b\n- tool: c'), 3)
  assert.equal(countTranscriptTurns('The user asked for a retry. The assistant added one.'), 0)
  assert.equal(countTranscriptTurns(''), 0)
})

test('the walk is bounded by depth and by node count', () => {
  const deep = { a: { b: { c: { d: 'x' } } } }
  assert.equal(walkStrings(deep, { maxDepth: 2, maxNodes: 1000 }).ok, false)
  assert.equal(walkStrings(deep, { maxDepth: 2, maxNodes: 1000 }).reason, 'depth')
  assert.equal(walkStrings(deep, { maxDepth: 20, maxNodes: 3 }).reason, 'nodes')
  const walked = walkStrings({ a: ['x'] }, { maxDepth: 20, maxNodes: 1000 })
  assert.equal(walked.ok, true)
  assert.deepEqual(walked.strings, [
    { pointer: '/a', value: 'a', isKey: true },
    { pointer: '/a/0', value: 'x', isKey: false },
  ])
})

test('every sample credential is caught end to end and none of them reaches a stream', async (t) => {
  for (const sample of SAMPLES) {
    const dir = await workspace(t)
    await fixture(dir, { packet: validPacket({ nextAction: `Continue with ${sample.value} in the environment.` }) })
    const result = await run(['--root', dir, '--now', NOW])
    const report = JSON.parse(result.stdout)

    const finding = report.findings.find((row) => row.ruleId === 'credential-in-packet')
    assert.ok(finding !== undefined, `${sample.id} was not reported`)
    assert.match(finding.evidence, new RegExp(`^${sample.id} matched \\d+ characters at offset \\d+`))
    assert.equal(result.code, 1)
    assert.ok(!result.stdout.includes(sample.value), `${sample.id} reached stdout`)
    assert.ok(!result.stderr.includes(sample.value), `${sample.id} reached stderr`)
  }
})

test('redaction replaces a credential shape with the name of the shape', () => {
  assert.equal(
    redactCredentials('run with AKIAIOSFODNN7EXAMPLE now'),
    'run with [redacted aws-access-key-id] now',
  )
  assert.equal(redactCredentials('nothing here'), 'nothing here')
})

test('a credential used as a field name is still found, and is redacted everywhere', async (t) => {
  const dir = await workspace(t)
  const packet = validPacket()
  packet[`ghp_${'e'.repeat(36)}`] = 'x'
  await fixture(dir, { packet })

  const result = await run(['--root', dir, '--now', NOW])
  const report = JSON.parse(result.stdout)
  const finding = report.findings.find((row) => row.ruleId === 'credential-in-packet')
  assert.ok(finding !== undefined)
  assert.match(finding.message, /The field name at/)

  // It reaches the report by two routes that have nothing to do with the
  // scanner -- the unknown-field message, and the JSON Pointer built from the
  // field name -- so both are asserted, on both streams.
  const unknown = report.findings.find((row) => row.ruleId === 'packet-unknown-field')
  assert.match(unknown.message, /\[redacted github-token\]/)
  assert.match(unknown.location.pointer, /\[redacted github-token\]/)
  assert.ok(!result.stdout.includes(`ghp_${'e'.repeat(36)}`), 'the token reached stdout')
  assert.ok(!result.stderr.includes(`ghp_${'e'.repeat(36)}`), 'the token reached stderr')
})
