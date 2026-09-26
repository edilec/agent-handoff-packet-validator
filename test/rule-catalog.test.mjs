/**
 * The severity table and docs/packet-rules.md agree, in both directions.
 *
 * This is a consistency check between two declarations, and it is written down
 * as one: it cannot catch a coordinated edit of both. What catches that is
 * test/severity-outcomes.test.mjs, which asserts exit codes.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { RULE_SEVERITY } from '../src/index.mjs'

const CATALOG = new URL('../docs/packet-rules.md', import.meta.url)

async function documentedRules() {
  const text = await readFile(CATALOG, 'utf8')
  const rules = new Map()
  for (const line of text.split('\n')) {
    const match = /^\| `([a-z0-9-]+)` \| (error|warning|info) \|/.exec(line)
    if (match !== null) rules.set(match[1], match[2])
  }
  return rules
}

test('every rule in the table is documented with the same severity', async () => {
  const documented = await documentedRules()
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(documented.get(ruleId), severity, `docs/packet-rules.md disagrees about ${ruleId}`)
  }
})

test('every documented rule exists in the table', async () => {
  const documented = await documentedRules()
  for (const ruleId of documented.keys()) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is documented but not implemented`)
  }
  assert.equal(documented.size, Object.keys(RULE_SEVERITY).length)
})

test('rule ids are stable kebab-case and the table is frozen', () => {
  for (const ruleId of Object.keys(RULE_SEVERITY)) assert.match(ruleId, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  assert.ok(Object.isFrozen(RULE_SEVERITY))
})
