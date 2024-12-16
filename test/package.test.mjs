/**
 * What the package ships, checked against what it says it ships.
 *
 * `docs/README.md` went out as the two-line scaffold placeholder the project
 * template leaves behind -- "Document the design, inputs, outputs, limits,
 * examples, and release checks here." -- inside the published `files` list, so
 * `npm pack` put an instruction to write the documentation where the
 * documentation was supposed to be. Nothing failed, because nothing looked.
 *
 * The scaffold sentence is written here in pieces, so this file does not
 * contain the needle it searches for and cannot pass by matching itself.
 */

import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCAFFOLD = ['Document the design, inputs, outputs,', 'limits, examples, and release checks here.'].join(' ')

async function manifest() {
  return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
}

/** Every markdown file the package publishes, by relative path. */
async function shippedMarkdown() {
  const { files } = await manifest()
  const found = []
  for (const entry of files) {
    const info = await stat(join(ROOT, entry))
    if (info.isDirectory()) {
      for (const name of (await readdir(join(ROOT, entry))).sort()) {
        if (name.endsWith('.md')) found.push(`${entry}/${name}`)
      }
    } else if (entry.endsWith('.md')) found.push(entry)
  }
  return found
}

test('every path the package promises to publish exists', async () => {
  const { files } = await manifest()
  assert.ok(files.length > 0, 'a package that declares no files ships whatever happens to be in the directory')
  for (const entry of files) {
    await assert.doesNotReject(() => stat(join(ROOT, entry)), `package.json ships "${entry}", which is not there`)
  }
})

test('no document the package publishes is still the unfilled scaffold', async () => {
  const shipped = await shippedMarkdown()
  assert.ok(shipped.includes('docs/README.md'), 'the file that shipped as a placeholder is no longer being checked')

  for (const name of shipped) {
    const text = await readFile(join(ROOT, name), 'utf8')
    assert.ok(!text.includes(SCAFFOLD), `${name} still carries the scaffold placeholder instead of documentation`)
    assert.ok(text.trim().split('\n').length > 2, `${name} is a heading and nothing else`)
  }
})
