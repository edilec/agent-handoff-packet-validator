/**
 * The shipped examples run, and they produce what the README says they do.
 *
 * One of them fails on purpose. An examples directory where everything passes
 * teaches nothing about what a failure looks like, and it lets a tool that has
 * stopped failing at all keep shipping.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { NOW, run } from './support.mjs'

const READY = fileURLToPath(new URL('../examples/ready', import.meta.url))
const NOT_READY = fileURLToPath(new URL('../examples/handoff-not-ready', import.meta.url))

test('the ready example passes, uncommitted work and all', async () => {
  const result = await run(['--root', READY, '--now', NOW])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.uncommittedChanges, 1)
  assert.equal(report.summary.carriedChanges, 1, 'the uncommitted file travels in a patch')
  assert.equal(report.summary.baseRevisionDeclared, true)
})

test('the not-ready example fails on all four of the things this tool exists to catch', async () => {
  const result = await run(['--root', NOT_READY, '--now', NOW])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')

  const ruleIds = new Set(report.findings.map((finding) => finding.ruleId))
  assert.ok(ruleIds.has('base-revision-missing'))
  assert.ok(ruleIds.has('uncommitted-change-unreachable'))
  assert.ok(ruleIds.has('credential-in-packet'))
  assert.ok(ruleIds.has('transcript-embedded'))

  assert.ok(!result.stdout.includes('AKIAIOSFODNN7EXAMPLE'), 'the example credential reached stdout')
  assert.ok(!result.stderr.includes('AKIAIOSFODNN7EXAMPLE'), 'the example credential reached stderr')
  assert.equal(report.summary.credentialMatches, 1)
})


/** Severity, rule id and location lines, with their column padding collapsed. */
function findingLines(text) {
  return text.split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => /^(ERROR|WARN|INFO) /.test(line))
}

/**
 * The README's failing-example block is output, and output is a contract.
 *
 * It listed transcript-embedded fourth -- errors grouped ahead of warnings --
 * while the documented and actual sort key, (file, pointer, ruleId, message),
 * puts /nextAction last. Ordering is part of what this catalog promises, so a
 * README showing a different one misdescribes it. Comparing the block against
 * the real run is the only version of this that cannot drift.
 */
test('the README prints the failing example in the order the tool emits', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const result = await run(['--root', NOT_READY, '--now', NOW])

  const documented = findingLines(readme)
  const emitted = findingLines(result.stderr)

  assert.ok(emitted.length >= 6, 'the failing example stopped producing findings')
  assert.deepEqual(documented, emitted, 'README.md shows a different order, or different findings, from the CLI')
})
