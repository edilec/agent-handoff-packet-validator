#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_PACKET_NAME, REQUIRED_PACKET_FIELDS,
  checkHandoffPacket, excerpt, exitCodeFor, formatReport, parseInstant, serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `agent-handoff-packet-validator

Check that a handoff packet says enough for another agent to continue, and
carries nothing it should not. Reads one JSON document. Runs no git command,
opens no repository, resolves no changed file, opens no socket and writes
nothing anywhere.

Required fields: ${REQUIRED_PACKET_FIELDS.join(', ')}.

The two failures this exists to catch:

  - A packet the successor cannot act on: no base revision, or a file that
    exists only in the sender's working tree with nothing carrying it across.
    Both read as complete and are unusable.
  - A packet carrying what it should not: a credential pasted in with a command,
    or a transcript pasted in place of a summary. Packets are forwarded, logged
    and quoted in reviews.

Usage:
  agent-handoff-packet-validator --root DIR [--packet FILE] [--now INSTANT]
                                 [--json] [thresholds] [limits]

Options:
  --root DIR                 Directory holding the packet (required)
  --packet FILE              Packet to read, relative to --root
                             (default ${DEFAULT_PACKET_NAME})
  --now INSTANT              Evaluation instant, UTC, as YYYY-MM-DDTHH:MM:SSZ.
                             Default: this host's clock. Staleness depends on
                             it, so it is recorded as summary.evaluatedAt
  --json                     Suppress the human summary on stderr

Thresholds (a packet that was read completely, judged):
  --max-age-hours N          A packet older than this is stale (default 72)
  --max-field-chars N        A single string longer than this is a wall of text
                             rather than a summary (default 2000)
  --max-transcript-turns N   This many speaker-labelled lines in one string is
                             an embedded transcript (default 6)

Limits (a packet that could not be read completely, reported):
  --max-depth N              Maximum nesting (default 12)
  --max-document-bytes N     Maximum packet size (default 262144)
  --max-entries N            Maximum entries in one list (default 500)
  --max-findings N           Maximum findings in one report (default 1000)
  --max-nodes N              Maximum values in one packet (default 20000)
  --max-runtime-ms N         Time budget, checked between entries. Not a hard
                             deadline: a run overshoots by the cost of the entry
                             in hand (default 10000)
  -h, --help                 Show this help
  -v, --version              Show the version

Every option that carries a value may be given once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

Where the line falls between exit 1 and exit 2:
  A field the packet omits is a fact ABOUT the packet, and it fails (exit 1).
  A document this tool could not read, decode, parse or finish walking is
  evidence it did not obtain, and that is incomplete (exit 2) -- never a pass,
  and never reported as absence.

What a pass means:
  The packet declares all nine required fields, every uncommitted change is
  carried by something, every check names the revision it ran at, and no string
  matched a credential shape or looked like a transcript. It does NOT mean the
  revision exists, that the changed files are really changed, that a recorded
  check ever ran, or that the packet holds no credential this tool has no
  pattern for.

Exit codes:
  0  the packet was read and no error-severity rule fired
  1  the packet was read and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-depth', 'maxDepth'],
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-entries', 'maxEntries'],
  ['--max-findings', 'maxFindings'],
  ['--max-nodes', 'maxNodes'],
  ['--max-runtime-ms', 'maxRuntimeMs'],
])

const POLICY_FLAGS = new Map([
  ['--max-age-hours', 'maxAgeHours'],
  ['--max-field-chars', 'maxFieldChars'],
  ['--max-transcript-turns', 'maxTranscriptTurns'],
])

const VALUE_FLAGS = new Map([
  ['--now', 'now'],
  ['--packet', 'packet'],
  ['--root', 'root'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, packet: null, now: null, json: false, limits: {}, policy: {} }
  const given = new Set()

  /**
   * A flag carrying a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--max-age-hours 24 --max-age-hours 9000` judges staleness against a
   * threshold nobody asked for. That is the same defect as an ignored typo,
   * which this tool also refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once(argument)
      options.json = true
    } else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else if (POLICY_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.policy[POLICY_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let now
  if (options.now !== null) {
    const parsed = parseInstant(options.now)
    if (!parsed.ok) {
      process.stderr.write('--now must be a UTC instant of the form YYYY-MM-DDTHH:MM:SSZ\n')
      return 2
    }
    now = parsed.ms
  }

  let report
  try {
    report = await checkHandoffPacket({
      root: options.root,
      limits: options.limits,
      policy: options.policy,
      ...(options.packet === null ? {} : { packet: options.packet }),
      ...(now === undefined ? {} : { now }),
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty rather
    // than carrying a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (options.now === null) {
    process.stderr.write(`evaluated at ${report.summary.evaluatedAt}, taken from this host's clock; pass --now to fix it\n`)
  }
  if (report.status === 'incomplete') {
    process.stderr.write('incomplete: this run is not a pass. Part of the packet was never examined.\n')
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
