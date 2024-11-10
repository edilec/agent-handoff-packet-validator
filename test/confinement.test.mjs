/**
 * Path confinement, and the false refusals a confinement must not produce.
 *
 * Rejecting `..` and absolute paths lexically is not confinement: a symbolic
 * link planted inside the root contains neither and points anywhere. Both real
 * paths are resolved and compared. Equally, a root reached THROUGH a symbolic
 * link -- every run under the macOS temp directory, where /var is a link to
 * /private/var -- must still work, because a guard that refuses everything
 * passes a confinement test while making the tool useless.
 */

import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { NOW, fixture, run, validPacket, workspace } from './support.mjs'

const SECRET = 'AKIAIOSFODNN7EXAMPLE'

test('a symbolic link inside the root pointing outside is refused, and its content is not echoed', async (t) => {
  const dir = await workspace(t)
  const root = join(dir, 'root')
  await mkdir(root, { recursive: true })
  await writeFile(join(dir, 'outside.json'), JSON.stringify(validPacket({ nextAction: SECRET })))
  await symlink(join(dir, 'outside.json'), join(root, 'handoff.json'))

  const result = await run(['--root', root, '--now', NOW])
  const report = JSON.parse(result.stdout)

  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(report.findings[0].ruleId, 'path-escapes-root')
  assert.ok(!result.stdout.includes(SECRET), 'out-of-root content reached stdout')
  assert.ok(!result.stderr.includes(SECRET), 'out-of-root content reached stderr')
})

test('a symbolic link to a path that does not exist is refused without creating anything', async (t) => {
  const dir = await workspace(t)
  const root = join(dir, 'root')
  await mkdir(root, { recursive: true })
  await symlink(join(dir, 'never-created.json'), join(root, 'handoff.json'))

  const result = await run(['--root', root, '--now', NOW])
  const report = JSON.parse(result.stdout)
  assert.equal(result.code, 2)
  assert.equal(report.status, 'incomplete')
  assert.ok(['path-escapes-root', 'input-unreadable'].includes(report.findings[0].ruleId))
})

test('a legitimate packet under a symlinked root is still read', async (t) => {
  const dir = await workspace(t)
  const real = join(dir, 'real')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'handoff.json'), JSON.stringify(validPacket()))
  const linked = join(dir, 'linked')
  await symlink(real, linked)

  const result = await run(['--root', linked, '--now', NOW])
  assert.equal(result.code, 0, 'a symlinked root must not be a false refusal')
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})

test('a packet named with .. or an absolute path is a configuration error', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { packet: validPacket() })

  for (const name of ['../elsewhere.json', join(dir, 'handoff.json')]) {
    const result = await run(['--root', dir, '--packet', name])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
  }
})

test('the reported file path is relative to the root, never a host path', async (t) => {
  const dir = await workspace(t)
  const packet = validPacket()
  delete packet.objective
  await fixture(dir, { packet })
  const result = await run(['--root', dir, '--now', NOW])
  const report = JSON.parse(result.stdout)

  assert.equal(report.findings[0].location.file, 'handoff.json')
  assert.ok(!result.stdout.includes(dir), 'the report carried an absolute host path')
})

test('this tool never opens a file the packet names', async (t) => {
  const dir = await workspace(t)
  // A changed path that names a file which does not exist, and could not be
  // read if it did: the validator reads the packet and nothing else, so this
  // passes rather than reporting a missing file.
  await fixture(dir, {
    packet: validPacket({ changes: [{ path: 'src/never-created.mjs', status: 'added', committed: true }] }),
  })
  const result = await run(['--root', dir, '--now', NOW])
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})
