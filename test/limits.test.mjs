/**
 * Every documented limit is enforced, reported by name, and reachable from the
 * command line. A documented limit the CLI never wires through is a limit that
 * does not exist, and this catalog has already shipped one.
 *
 * The thresholds are checked the same way, and they are kept separate on
 * purpose: crossing a threshold is a verdict about a packet that was read
 * completely, while reaching a limit means part of it was never read.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS, DEFAULT_POLICY, EXCERPT_LIMIT, HARD_LIMITS, HARD_POLICY,
  checkHandoffPacket, excerpt, validateLimits, validatePolicy,
} from '../src/index.mjs'
import { BASE_REVISION, NOW, fixture, run, validPacket, validate, workspace } from './support.mjs'

const LIMIT_CASES = [
  {
    flag: '--max-document-bytes', value: '64', ruleId: 'input-too-large',
    packet: () => validPacket(), expect: /maxDocumentBytes limit of 64/,
  },
  {
    flag: '--max-depth', value: '2', ruleId: 'packet-too-deep',
    packet: () => validPacket(), expect: /maxDepth limit of 2/,
  },
  {
    flag: '--max-nodes', value: '5', ruleId: 'too-many-nodes',
    packet: () => validPacket(), expect: /maxNodes limit of 5/,
  },
  {
    flag: '--max-entries', value: '1', ruleId: 'too-many-entries',
    packet: () => validPacket({
      changes: [
        { path: 'src/a.mjs', status: 'added', committed: true },
        { path: 'src/b.mjs', status: 'added', committed: true },
      ],
    }),
    expect: /maxEntries limit of 1/,
  },
]

for (const entry of LIMIT_CASES) {
  test(`${entry.flag} is enforced, named in the finding, and never a silent truncation`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, { packet: entry.packet() })

    const generous = await run(['--root', dir, '--now', NOW])
    assert.ok(
      !JSON.parse(generous.stdout).findings.some((row) => row.ruleId === entry.ruleId),
      `${entry.flag}: the fixture already trips the limit at its default, so the flag proves nothing`,
    )

    const bounded = await run(['--root', dir, '--now', NOW, entry.flag, entry.value])
    const report = JSON.parse(bounded.stdout)
    const finding = report.findings.find((row) => row.ruleId === entry.ruleId)
    assert.ok(finding !== undefined, `expected ${entry.ruleId} from ${entry.flag} ${entry.value}`)
    assert.match(finding.message, entry.expect)
    assert.equal(report.status, 'incomplete')
    assert.equal(bounded.code, 2)
  })
}

const THRESHOLD_CASES = [
  {
    flag: '--max-age-hours', value: '2', ruleId: 'packet-stale', severity: 'warning', exit: 0,
    packet: () => validPacket({ generated: '2026-09-14T00:00:00Z' }), expect: /maxAgeHours threshold of 2/,
  },
  {
    flag: '--max-field-chars', value: '40', ruleId: 'field-too-long', severity: 'error', exit: 1,
    packet: () => validPacket({ objective: 'x'.repeat(60) }), expect: /maxFieldChars threshold of 40/,
  },
  {
    flag: '--max-transcript-turns', value: '2', ruleId: 'transcript-embedded', severity: 'error', exit: 1,
    packet: () => validPacket({ nextAction: 'user: a\nassistant: b' }), expect: /maxTranscriptTurns threshold of 2/,
  },
]

for (const entry of THRESHOLD_CASES) {
  test(`${entry.flag} is a verdict about a packet that was read, not an incomplete run`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, { packet: entry.packet() })

    const generous = await run(['--root', dir, '--now', NOW])
    assert.ok(
      !JSON.parse(generous.stdout).findings.some((row) => row.ruleId === entry.ruleId),
      `${entry.flag}: the fixture already crosses the threshold at its default`,
    )

    const bounded = await run(['--root', dir, '--now', NOW, entry.flag, entry.value])
    const report = JSON.parse(bounded.stdout)
    const finding = report.findings.find((row) => row.ruleId === entry.ruleId)
    assert.ok(finding !== undefined, `expected ${entry.ruleId} from ${entry.flag} ${entry.value}`)
    assert.match(finding.message, entry.expect)
    assert.equal(finding.severity, entry.severity)
    assert.notEqual(report.status, 'incomplete')
    assert.equal(bounded.code, entry.exit)
  })
}

test('--max-runtime-ms is wired through the CLI and stops the run', async (t) => {
  const dir = await workspace(t)
  const changes = []
  for (let index = 0; index < 400; index += 1) {
    changes.push({ path: `src/file-${index}.mjs`, status: 'modified', committed: true })
  }
  await fixture(dir, {
    packet: validPacket({
      changes,
      checks: [{ name: 'unit', command: 'npm test', result: 'pass', revision: BASE_REVISION }],
    }),
  })

  const result = await run(['--root', dir, '--now', NOW, '--max-runtime-ms', '1'])
  const report = JSON.parse(result.stdout)
  const finding = report.findings.find((row) => row.ruleId === 'time-budget-exceeded')
  assert.ok(finding !== undefined, 'the CLI did not pass the time budget through')
  assert.match(finding.message, /budget of 1 ms/)
  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
})

test('a limit or threshold the caller invents is refused rather than ignored', () => {
  assert.throws(() => validateLimits({ maxEntry: 5 }), /Unknown limit "maxEntry"/)
  assert.throws(() => validateLimits({ maxEntries: 0 }), /between 1 and/)
  assert.throws(() => validateLimits({ maxEntries: HARD_LIMITS.maxEntries + 1 }), /between 1 and/)
  assert.deepEqual({ ...validateLimits() }, { ...DEFAULT_LIMITS })

  assert.throws(() => validatePolicy({ maxAgeHour: 5 }), /Unknown policy key "maxAgeHour"/)
  assert.throws(() => validatePolicy({ maxAgeHours: 0 }), /between 1 and/)
  assert.throws(() => validatePolicy({ maxAgeHours: HARD_POLICY.maxAgeHours + 1 }), /between 1 and/)
  assert.deepEqual({ ...validatePolicy() }, { ...DEFAULT_POLICY })
})

test('a mistyped flag is a configuration error with an empty stdout', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })
  const result = await run(['--root', dir, '--max-entry', '2'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--max-entry"/)
})

test('an option the API does not know is refused rather than ignored', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })
  await assert.rejects(
    () => checkHandoffPacket({ root: dir, nowish: 1 }),
    /Unknown option "nowish"/,
  )
})

test('the walk bound is reported as a bound, with no claim about what was not scanned', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({ nextAction: 'Run it with AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE set.' }),
  })

  const bounded = await validate(dir, ['--max-nodes', '5'])
  assert.equal(bounded.code, 2)
  const finding = bounded.report.findings.find((row) => row.ruleId === 'too-many-nodes')
  assert.match(finding.message, /nothing is claimed about what it carries/)
  // The credential is really there; the bounded run simply does not claim it is
  // not, and it does not quote it either.
  assert.equal(bounded.report.summary.credentialMatches, 0)
  assert.ok(!bounded.stdout.includes('AKIAIOSFODNN7EXAMPLE'))

  const full = await validate(dir)
  assert.equal(full.report.summary.credentialMatches, 1)
})


/**
 * The output bound, which is a limit like any other and was defended by
 * nothing.
 *
 * The house contract calls evidence "length-bounded". Removing the length check
 * from excerpt() left all 137 tests green, so "bounded" was a declaration with
 * no behavioural defence anywhere in the suite.
 *
 * Both halves are here: the function at its own boundary, and every string in a
 * real report driven from a packet built to be long in each place an untrusted
 * value reaches output -- a check name, a changed path, an unknown field name.
 */
test('excerpt bounds what it returns, and does not truncate what already fits', () => {
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT)), 'x'.repeat(EXCERPT_LIMIT), 'a value at the limit is emitted whole')
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT + 1)).length, EXCERPT_LIMIT + 3)
  assert.ok(excerpt('x'.repeat(EXCERPT_LIMIT + 1)).endsWith('...'))
  assert.equal(excerpt('x'.repeat(5000), 40).length, 43)
  assert.equal(excerpt('short', 40), 'short')
  assert.throws(() => excerpt('x', 0), /positive integer/)
})

/** The widest string the report may carry: the message limit plus an ellipsis. */
const OUTPUT_LIMIT = 403

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsOf(entry, found)
  return found
}

test('no string in a report is longer than the widest documented bound', async (t) => {
  const dir = await workspace(t)
  const longPath = `src/${'p'.repeat(390)}.mjs`
  await fixture(dir, {
    packet: validPacket({
      [`unknown_${'u'.repeat(1500)}`]: 'x',
      changes: [
        { path: longPath, status: 'modified', committed: true },
        { path: longPath, status: 'modified', committed: false },
      ],
      checks: [
        { name: 'n'.repeat(1500), command: 'npm test', result: 'fail', revision: BASE_REVISION },
      ],
    }),
  })
  const result = await validate(dir)

  assert.ok(result.report.findings.length >= 4, 'the fixture stopped producing the findings it was built for')
  for (const value of stringsOf(result.report)) {
    assert.ok(
      value.length <= OUTPUT_LIMIT,
      `a report string ran to ${value.length} characters: ${value.slice(0, 80)}...`,
    )
  }
  for (const line of result.stderr.split('\n')) {
    assert.ok(line.length <= OUTPUT_LIMIT + 20, `a human summary line ran to ${line.length} characters`)
  }
})
