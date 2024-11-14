/**
 * A value that cannot be turned into a string costs nothing but its own field.
 *
 * `String({toString: {}})` throws `Cannot convert object to primitive value`,
 * and `{"toString": {}}` is four characters of JSON. Uncaught it took the whole
 * report with it: exit 2 with an EMPTY stdout -- the shape this contract
 * reserves for a configuration error -- so one malformed packet suppressed the
 * findings for every other input in the same run, and the reader was never told
 * which field caused it. The exposed site was `schemaVersion`, which is read
 * before any schema check and therefore on every packet.
 *
 * The fix is at the one boundary every untrusted string already passes through,
 * not at each `String(...)` call site. Three separate claims are pinned here,
 * because a guard that mangled every value would satisfy the first alone:
 *
 *   - the poison is real: `String(value)` genuinely throws for it;
 *   - the boundary describes it by shape, and the shape carries nothing of the
 *     packet -- a credential in the same object does not ride out on it, which
 *     a `JSON.stringify` "fix" would have allowed;
 *   - ordinary values are untouched, a real custom `toString` included.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, renderable } from '../src/index.mjs'
import { redactCredentials } from '../src/scan.mjs'
import { fixture, ruleIds, validPacket, validate, workspace } from './support.mjs'

/** An object JSON can carry and `String` cannot render, with a secret beside it. */
const SECRET = 'AKIAIOSFODNN7EXAMPLE'
const poison = () => ({ toString: {}, leak: SECRET })

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsOf(entry, found)
  return found
}

test('the poison value really does throw in String(), so the rest of this file is about something', () => {
  assert.throws(() => String(poison()), TypeError)
  assert.throws(() => `${poison()}`, TypeError)
  assert.throws(() => String([poison()]), TypeError)
})

test('the boundary describes an unrenderable value by shape and reproduces none of it', () => {
  assert.equal(renderable(poison()), '[object]')
  assert.equal(excerpt(poison()), '[object]')
  assert.equal(renderable([poison()]), '[array]')
  assert.equal(excerpt([poison()]), '[array]')
  assert.equal(redactCredentials(poison()), '[object]')
  assert.ok(!excerpt(poison()).includes(SECRET))
  assert.ok(!excerpt(poison()).includes('leak'))
})

test('ordinary values are unaffected by the shape description', () => {
  assert.equal(excerpt('src/upload.mjs'), 'src/upload.mjs')
  assert.equal(excerpt(42), '42')
  assert.equal(excerpt(0), '0')
  assert.equal(excerpt(null), 'null')
  assert.equal(excerpt(true), 'true')
  assert.equal(excerpt({ toString: () => 'a real custom toString' }), 'a real custom toString')
  assert.equal(excerpt([1, 2, 3]), '1,2,3')
  assert.equal(renderable('already a string'), 'already a string')
})

for (const [label, value, shape] of [
  ['an object', poison(), '"[object]"'],
  ['an array', [poison()], '"[array]"'],
]) {
  test(`a schemaVersion that is ${label} reports incomplete with a report on stdout, not an empty stream`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, { packet: validPacket({ schemaVersion: value }) })
    const result = await validate(dir)

    assert.notEqual(result.stdout, '', 'stdout was empty: the run had a subject and owes a report about it')
    assert.equal(result.report.status, 'incomplete')
    assert.equal(result.code, 2)
    assert.ok(ruleIds(result.report).includes('schema-version-unsupported'))
    assert.ok(
      stringsOf(result.report).some((entry) => entry.includes(shape)),
      `nothing in the report described the value as ${shape}`,
    )
    assert.ok(!result.stdout.includes(SECRET), 'the secret beside the unrenderable value reached stdout')
    assert.ok(!result.stderr.includes(SECRET), 'the secret beside the unrenderable value reached stderr')
    assert.ok(!result.stderr.includes('Cannot convert object to primitive value'))
  })
}

test('an unrenderable value in an unknown field does not suppress the rest of the report', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket({ misspelt: poison(), objective: '   ' }) })
  const result = await validate(dir)

  assert.notEqual(result.stdout, '')
  const ids = ruleIds(result.report)
  assert.ok(ids.includes('packet-unknown-field'))
  assert.ok(ids.includes('objective-missing'), 'the other field\'s finding was lost with the malformed one')
  assert.ok(!result.stdout.includes(SECRET))
})
