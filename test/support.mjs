/** Shared fixtures: a workspace, a valid packet, and a real CLI run. */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/agent-handoff-packet-validator.mjs', import.meta.url))
export const PACKET_NAME = 'handoff.json'
export const NOW = '2026-09-14T12:00:00Z'
export const BASE_REVISION = '3f9a2c1d4e5b6a7c8d9e0f1a2b3c4d5e6f708192'
export const OTHER_REVISION = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** A temporary directory, removed when the test finishes. */
export async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-handoff-packet-validator-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * A packet that passes, so that every test can change exactly one thing.
 *
 * A fixture that already fails would let a test pass for the wrong reason, so
 * `test/acceptance.test.mjs` asserts this one really does exit 0 first.
 */
export function validPacket(overrides = {}) {
  return {
    schemaVersion: '1',
    generated: '2026-09-14T09:30:00Z',
    objective: 'Make the export job retry a failed upload three times before giving up.',
    repository: 'services/export-worker',
    baseRevision: BASE_REVISION,
    changes: [
      { path: 'src/upload.mjs', status: 'modified', committed: true },
    ],
    acceptance: ['A failed upload is retried three times with the documented backoff.'],
    checks: [
      { name: 'unit', command: 'npm test', result: 'pass', revision: BASE_REVISION },
    ],
    blockers: [],
    nextAction: 'Wire the backoff constant into the worker configuration.',
    ...overrides,
  }
}

export async function fixture(dir, { packet, raw = null, name = PACKET_NAME } = {}) {
  const path = join(dir, name)
  await writeFile(path, raw === null ? JSON.stringify(packet, null, 2) : raw)
  return path
}

/** Run the real CLI. Returns the exit code and both streams as strings. */
export function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
      },
    )
  })
}

/**
 * Run the CLI over a workspace with the usual flags, and parse stdout.
 *
 * `--now` defaults to a fixed instant so staleness never depends on the day the
 * suite runs; passing another one in `extra` replaces it rather than repeating
 * it, because a repeated flag is a configuration error.
 */
export async function validate(dir, extra = []) {
  const now = extra.includes('--now') ? [] : ['--now', NOW]
  const result = await run(['--root', dir, ...now, ...extra])
  const report = result.stdout === '' ? null : JSON.parse(result.stdout)
  return { ...result, report }
}

export function findingFor(report, ruleId) {
  return report.findings.find((finding) => finding.ruleId === ruleId)
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}
