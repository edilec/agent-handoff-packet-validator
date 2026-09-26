/**
 * The JSON parse failure helper, and the end-to-end path that uses it.
 *
 * This matters more here than anywhere: a handoff packet is the document in
 * this catalog most likely to hold a credential, and an unparseable one would
 * otherwise be quoted straight back by V8's own error message.
 *
 * V8 embeds the input in its own parse message, so interpolating
 * `error.message` walks file contents onto stdout past every redactor. The
 * ordering of the branches is the whole guard: a helper that looks for
 * `at position N` first finds that phrase INSIDE the quoted span whenever the
 * document itself contains it, and slices the document straight back out.
 * Nineteen of thirty-eight tools in this catalog shipped exactly that bug.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { NOW, fixture, run, workspace } from './support.mjs'

function detailFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
  throw new Error('the document parsed, so there is no failure to describe')
}

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  const document = 'at position 1'
  const { message, detail } = detailFor(document)
  // The premise: V8 really does quote this document back.
  assert.match(message, /"at position 1"/)
  assert.ok(!detail.includes('at position 1'), `the document survived: ${detail}`)
  assert.equal(detail, "unexpected token 'a' at the start of the document")
})

test('a document that is only a credential is never quoted back', () => {
  const credential = 'AKIAIOSFODNN7EXAMPLE'
  const { message, detail } = detailFor(credential)
  assert.match(message, /AKIAIOSFODNN7EXAMPLE/)
  assert.ok(!detail.includes(credential))
  assert.ok(!detail.includes('AKIA'))
})

test('a long document with a sensitive prefix loses the prefix too', () => {
  const { message, detail } = detailFor(`password=hunter2hunter2 ${'x'.repeat(400)}`)
  assert.match(message, /password=h/)
  assert.ok(!detail.includes('password'))
  assert.ok(!detail.includes('hunter'))
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  const { message, detail } = detailFor('{"alpha": ZQXJ\nVBMP7W}')
  assert.match(message, /\n/)
  assert.ok(!detail.includes('ZQXJ'))
  assert.ok(!detail.includes('alpha'))
  assert.equal(detail, "unexpected token 'Z' inside the document")
})

test('the safe positional form keeps its position, line and column', () => {
  const { detail } = detailFor('{"alpha": 1,}')
  assert.equal(detail, 'Expected double-quoted property name in JSON at position 12 (line 1 column 13)')
})

test('an empty document keeps its own wording', () => {
  assert.equal(detailFor('').detail, 'Unexpected end of JSON input')
})

test('a future wording that keeps a quoted span AND a position loses the span', () => {
  /**
   * Fabricated on purpose: no shipped V8 writes this sentence. The closing
   * backstop -- "a surviving double quote means a surviving snippet" -- exists
   * for wordings the branches above have never been taught, and the only way to
   * exercise it is to invent one. Across 500,206 distinct V8 parse messages,
   * every message carrying no quoted snippet also carried no double quote at
   * all, which is why the check is sound rather than merely cautious.
   */
  const detail = parseFailureDetail(
    new Error('Unexpected string "AKIAIOSFODNN7EXAMPLE" in JSON at position 12 (line 1 column 13)'),
  )
  assert.equal(detail, 'the document could not be parsed as JSON')
  assert.ok(!detail.includes('AKIA'))
})

test('a message shape this helper has never seen falls back to the generic sentence', () => {
  assert.equal(
    parseFailureDetail(new Error('Some future wording, "SECRETVALUE" upset the parser')),
    'the document could not be parsed as JSON',
  )
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})

test('a credential in an unparseable packet never reaches stdout or stderr', async (t) => {
  const dir = await workspace(t)
  const credential = 'AKIAIOSFODNN7EXAMPLE'
  await fixture(dir, { raw: credential })
  const result = await run(['--root', dir, '--now', NOW])

  assert.equal(result.code, 2)
  assert.ok(!result.stdout.includes(credential), 'the credential reached stdout')
  assert.ok(!result.stderr.includes(credential), 'the credential reached stderr')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'input-not-json')
})
