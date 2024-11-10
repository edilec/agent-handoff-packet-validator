/**
 * Every untrusted string is stripped of forging and hiding characters on its
 * way out -- identifiers included, not only excerpt fields.
 *
 * One test per character class, three routes each: a field name, a check name
 * and a schema version. Two of the three are identifiers, because a sibling
 * tool sanitised its evidence field carefully and let a page id containing a
 * newline forge whole lines in the human report.
 *
 * Three assertions per case, because one alone would pass for the wrong reason:
 * no report string carries the character (which JSON.stringify would satisfy on
 * its own for C0), some report string carries the flattened rendering (so the
 * value was sanitised rather than dropped), and the human summary does not
 * carry the raw marker (checking stderr for a bare newline would be meaningless
 * -- the summary is made of lines -- so the marker is checked whole).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTROL_CLASSES } from '../src/index.mjs'
import { BASE_REVISION, NOW, fixture, run, validPacket, workspace } from './support.mjs'

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsOf(entry, found)
  return found
}

const ROUTES = [
  {
    name: 'an unknown field name',
    ruleId: 'packet-unknown-field',
    marker: (char) => `extra${char}field`,
    flattened: 'extra field',
    packet: (char) => validPacket({ [`extra${char}field`]: 'x' }),
  },
  {
    name: 'a check name',
    ruleId: 'check-not-passing',
    marker: (char) => `unit${char}suite`,
    flattened: 'unit suite',
    packet: (char) => validPacket({
      checks: [{ name: `unit${char}suite`, command: 'npm test', result: 'fail', revision: BASE_REVISION }],
    }),
  },
  {
    name: 'a schema version',
    ruleId: 'schema-version-unsupported',
    marker: (char) => `2${char}0`,
    flattened: '2 0',
    packet: (char) => validPacket({ schemaVersion: `2${char}0` }),
  },
]

for (const [className, codePoints] of Object.entries(CONTROL_CLASSES)) {
  test(`${className} characters never reach the report`, async (t) => {
    for (const codePoint of codePoints) {
      const char = String.fromCodePoint(codePoint)
      const label = `U+${codePoint.toString(16).padStart(4, '0')}`
      for (const route of ROUTES) {
        const dir = await workspace(t)
        await fixture(dir, { packet: route.packet(char) })
        const result = await run(['--root', dir, '--now', NOW])
        const report = JSON.parse(result.stdout)
        const strings = stringsOf(report)

        assert.ok(
          report.findings.some((finding) => finding.ruleId === route.ruleId),
          `expected ${route.ruleId} for ${label} through ${route.name}`,
        )
        for (const value of strings) {
          assert.ok(!value.includes(char), `${label} survived into the report through ${route.name}: ${JSON.stringify(value)}`)
        }
        assert.ok(
          strings.some((value) => value.includes(route.flattened)),
          `${label} through ${route.name}: nothing carried the flattened value ${JSON.stringify(route.flattened)}`,
        )
        assert.ok(
          !result.stderr.includes(route.marker(char)),
          `${label} survived into the human summary through ${route.name}`,
        )
      }
    }
  })
}

test('a bidi override in a changed path is refused rather than echoed', async (t) => {
  const dir = await workspace(t)
  const override = String.fromCodePoint(0x202e)
  await fixture(dir, {
    packet: validPacket({ changes: [{ path: `src/gnp${override}sjm.a`, status: 'added', committed: true }] }),
  })
  const result = await run(['--root', dir, '--now', NOW])
  const report = JSON.parse(result.stdout)

  assert.ok(report.findings.some((finding) => finding.ruleId === 'change-path-invalid'))
  assert.equal(result.code, 1)
  for (const value of stringsOf(report)) assert.ok(!value.includes(override))
  assert.ok(!result.stderr.includes(override))
})
