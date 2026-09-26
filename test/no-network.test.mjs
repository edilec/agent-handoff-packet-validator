/**
 * The tool opens no socket and runs no subprocess.
 *
 * This is a source scan, and a source scan is a weak instrument: it proves no
 * networking or process module is imported and no fetch is called by name, and
 * it would miss an indirect call. It is here because it is cheap and it catches
 * the realistic mistake -- someone adding a convenience `git rev-parse` -- not
 * because it is a proof. The stronger statement is structural: the package
 * declares no dependencies at all.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const FORBIDDEN = [
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls',
  'node:child_process', 'execFile', 'spawn(',
  'fetch(', 'XMLHttpRequest', 'WebSocket',
]

test('no source file imports a networking or process module', async () => {
  const roots = [new URL('../src/', import.meta.url), new URL('../bin/', import.meta.url)]
  for (const root of roots) {
    for (const name of await readdir(root)) {
      const text = await readFile(new URL(name, root), 'utf8')
      for (const needle of FORBIDDEN) {
        assert.ok(!text.includes(needle), `${name} mentions ${needle}`)
      }
    }
  }
})

test('the only filesystem call is a read', async () => {
  const roots = [new URL('../src/', import.meta.url), new URL('../bin/', import.meta.url)]
  for (const root of roots) {
    for (const name of await readdir(root)) {
      const text = await readFile(new URL(name, root), 'utf8')
      // Call forms, not bare words: "renamed" is a change status this tool
      // reads about, and a needle that matched it would fail for the wrong
      // reason -- which is its own kind of useless test.
      for (const needle of ['writeFile(', 'mkdir(', 'rm(', 'unlink(', 'rename(', 'appendFile(', 'createWriteStream(']) {
        assert.ok(!text.includes(needle), `${name} mentions ${needle}; this tool writes nothing`)
      }
    }
  }
})

test('the package declares no dependencies of any kind', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
})
