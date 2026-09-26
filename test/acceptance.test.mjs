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


/**
 * A blocker with no usable summary.
 *
 * The rule is documented -- "This blocker has no usable summary", error -- and
 * removing the requirement turned a failing packet into a clean pass with all
 * 137 tests still green. blocker-invalid stayed covered by its other routes (a
 * blocker that is not an object, a blocker with an unknown field), so the
 * severity-coverage test was satisfied by rules that had nothing to do with
 * this one. A rule with several routes needs a case per route.
 */
test('a blocker that names an owner but says nothing is refused, and not counted', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket({ blockers: [{ owner: 'someone' }] }) })

  const { code, report } = await validate(dir)
  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  const finding = findingFor(report, 'blocker-invalid')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.pointer, '/blockers/0/summary')
  assert.match(finding.message, /no usable "summary"/)
  assert.equal(report.summary.blockers, 0, 'an unusable blocker was counted as one')
})

test('a blocker whose summary is blank or not a string is refused the same way', async (t) => {
  for (const summary of ['', '   ', 42, null, ['a list']]) {
    const dir = await workspace(t)
    await fixture(dir, { packet: validPacket({ blockers: [{ summary, owner: 'someone' }] }) })

    const { code, report } = await validate(dir)
    assert.equal(code, 1, `a summary of ${JSON.stringify(summary)} was accepted`)
    assert.equal(findingFor(report, 'blocker-invalid').location.pointer, '/blockers/0/summary')
    assert.equal(report.summary.blockers, 0)
  }
})

/**
 * `branch` is optional, and "optional" was being read as "unread".
 *
 * It sat in ALLOWED_PACKET_FIELDS and nothing ever looked at it, so every shape
 * below reported a clean pass -- including an object whose `toString` is not
 * callable, which is the value that costs other tools their whole report. An
 * accepted-and-ignored field is exactly what the unknown-field rule exists to
 * prevent, so it is refused here too.
 */
test('a declared branch that is not a usable name is refused, not ignored', async (t) => {
  for (const branch of [42, '', '   ', null, ['main'], {}, { toString: {} }, `feature${String.fromCharCode(0x0a)}main`]) {
    const dir = await workspace(t)
    await fixture(dir, { packet: validPacket({ branch }) })

    const { code, report } = await validate(dir)
    assert.equal(code, 1, `a branch of ${JSON.stringify(branch)} was accepted`)
    assert.equal(report.status, 'fail')
    const finding = findingFor(report, 'branch-invalid')
    assert.equal(finding.severity, 'error')
    assert.equal(finding.location.pointer, '/branch')
  }
})

/**
 * The other half, without which a rule that refuses every branch would pass the
 * test above while making the field unusable.
 */
test('an omitted branch is silent, and a usable one passes', async (t) => {
  const absent = await workspace(t)
  await fixture(absent, { packet: validPacket() })
  const omitted = await validate(absent)
  assert.equal(omitted.code, 0)
  assert.equal(ruleIds(omitted.report).includes('branch-invalid'), false)

  for (const branch of ['retry-uploads', 'feature/retry-uploads', 'release-2026.09']) {
    const dir = await workspace(t)
    await fixture(dir, { packet: validPacket({ branch }) })
    const { code, report } = await validate(dir)
    assert.equal(code, 0, `a branch of ${JSON.stringify(branch)} was refused`)
    assert.deepEqual(report.findings, [])
  }
})

test('a blocker that says what is blocked passes and is counted', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({
      blockers: [
        { summary: 'The staging queue is full.', owner: 'platform' },
        { summary: 'The vendor has not replied.' },
      ],
    }),
  })

  const { code, report } = await validate(dir)
  assert.equal(code, 0, 'a requirement that refuses every blocker is not a requirement')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.blockers, 2)
})

/**
 * `branch` was not the only optional field nobody read.
 *
 * A change's `note` and a blocker's `owner` and `detail` sat in their own
 * allowlists and were read by nothing, and a check's `includesUncommitted` was
 * read as `!== true`, so `"includesUncommitted": "yes"` was recorded as saying
 * the opposite of what its author meant. Fixing `branch` alone and writing
 * "optional is about omitting the field, not about what may go in it" into the
 * README would have documented a coverage that did not exist.
 *
 * One case per field, each changing exactly one thing about a packet that
 * otherwise passes.
 */
const OPTIONAL_FIELDS = [
  {
    name: 'a change\'s "note"',
    ruleId: 'change-invalid',
    pointer: '/changes/0/note',
    build: (value) => validPacket({ changes: [{ path: 'src/upload.mjs', status: 'modified', committed: true, note: value }] }),
    usable: 'Rewritten in place; the diff is small.',
  },
  {
    name: 'a blocker\'s "owner"',
    ruleId: 'blocker-invalid',
    pointer: '/blockers/0/owner',
    build: (value) => validPacket({ blockers: [{ summary: 'The staging queue is full.', owner: value }] }),
    usable: 'platform',
  },
  {
    name: 'a blocker\'s "detail"',
    ruleId: 'blocker-invalid',
    pointer: '/blockers/0/detail',
    build: (value) => validPacket({ blockers: [{ summary: 'The staging queue is full.', detail: value }] }),
    usable: 'It has been full since the vendor incident on the 12th.',
  },
]

for (const field of OPTIONAL_FIELDS) {
  test(`${field.name} that is declared and unusable is refused, not ignored`, async (t) => {
    for (const value of [42, '', '   ', null, ['a list'], {}, { toString: {} }, `first${String.fromCharCode(0x0a)}second`]) {
      const dir = await workspace(t)
      await fixture(dir, { packet: field.build(value) })

      const { code, report } = await validate(dir)
      assert.equal(code, 1, `${field.name} of ${JSON.stringify(value)} was accepted`)
      assert.equal(report.status, 'fail')
      const finding = findingFor(report, field.ruleId)
      assert.equal(finding.severity, 'error')
      assert.equal(finding.location.pointer, field.pointer)
    }
  })

  test(`${field.name} omitted is silent, and a usable one passes`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, { packet: field.build(field.usable) })
    const { code, report } = await validate(dir)

    assert.equal(code, 0, `a usable ${field.name} was refused`)
    assert.equal(report.status, 'pass')
    assert.deepEqual(report.findings, [], 'a check that refuses everything makes the field useless')
  })
}

/**
 * `includesUncommitted` is the one where accepting anything was worse than
 * ignoring it: the flag decides whether a passing check covers the working
 * tree, and every non-boolean was read as "it does not".
 */
test('a check that declares includesUncommitted as something other than a boolean is refused', async (t) => {
  for (const value of ['yes', 1, 0, null, {}, []]) {
    const dir = await workspace(t)
    await fixture(dir, {
      packet: validPacket({
        checks: [{ name: 'unit', command: 'npm test', result: 'pass', revision: BASE_REVISION, includesUncommitted: value }],
      }),
    })

    const { code, report } = await validate(dir)
    assert.equal(code, 1, `includesUncommitted of ${JSON.stringify(value)} was accepted and read as false`)
    const finding = findingFor(report, 'check-invalid')
    assert.equal(finding.location.pointer, '/checks/0/includesUncommitted')
  }
})

test('includesUncommitted omitted stays the conservative default, and either boolean passes', async (t) => {
  for (const value of [true, false]) {
    const dir = await workspace(t)
    await fixture(dir, {
      packet: validPacket({
        checks: [{ name: 'unit', command: 'npm test', result: 'pass', revision: BASE_REVISION, includesUncommitted: value }],
      }),
    })
    const { code, report } = await validate(dir)
    assert.equal(code, 0, `includesUncommitted: ${value} was refused`)
    assert.deepEqual(report.findings, [])
  }

  // Omitted, with an uncommitted change in the packet: still the warning that
  // says the pass does not describe the tree, not a type complaint.
  const dir = await workspace(t)
  await fixture(dir, {
    packet: validPacket({
      changes: [{ path: 'src/upload.mjs', status: 'modified', committed: false, carriedIn: 'patches/0001.patch' }],
    }),
  })
  const { report } = await validate(dir)
  assert.ok(ruleIds(report).includes('check-excludes-uncommitted'))
  assert.equal(findingFor(report, 'check-invalid'), undefined)
})
