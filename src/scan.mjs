/**
 * What a handoff packet must not carry: credentials, and whole transcripts.
 *
 * Both checks are static and local. Nothing here resolves a path, opens a
 * socket or verifies a secret against anything -- a match is a shape in a
 * string, and the report says only which shape matched, where, and how long it
 * was. **The matched text never leaves this module.** That is the entire
 * discipline of the credential check: a validator that quoted the credential it
 * found would copy it into a report, a CI log and a review comment, which is
 * strictly worse than not looking.
 */

import { escapePointerSegment, renderable } from './text.mjs'

/**
 * Credential shapes, each one a published prefix format rather than a guess.
 *
 * This is a fixed list, not a secret scanner. It has no entropy heuristic, no
 * allowlist and no verification step, so it will miss a bespoke token and it
 * will flag a documentation example. Both are stated in the README: the list is
 * here to catch the realistic accident -- a command line pasted into the packet
 * with its own environment attached -- not to certify that a packet is clean.
 */
export const CREDENTIAL_PATTERNS = Object.freeze([
  Object.freeze({ id: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/ }),
  Object.freeze({ id: 'private-key-block', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ }),
  Object.freeze({ id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ }),
  Object.freeze({ id: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ }),
  Object.freeze({ id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ }),
  Object.freeze({ id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ }),
  Object.freeze({ id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ }),
  Object.freeze({ id: 'json-web-token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/ }),
  Object.freeze({ id: 'authorization-header', pattern: /\bauthorization\s*[:=]\s*(?:bearer|basic|token)\s+\S{6,}/i }),
  Object.freeze({ id: 'secret-assignment', pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[^\s"'&]{6,}/i }),
])

/**
 * Each pattern again, with the global flag, for redaction.
 *
 * Derived from the list above rather than written out again, so a pattern
 * cannot be added to one and forgotten in the other. Built once at load rather
 * than per call.
 */
const REDACTORS = CREDENTIAL_PATTERNS.map(({ id, pattern }) => ({
  id, global: new RegExp(pattern.source, `${pattern.flags}g`),
}))

/**
 * Replace anything credential-shaped with a placeholder naming the shape.
 *
 * This is the last line rather than the first. The scanner already refuses to
 * carry a matched value into a finding, but a credential can reach the report
 * by a route that has nothing to do with the scanner: a field NAME the packet
 * invented, which is echoed back to say it is unknown, and which lands in a
 * JSON Pointer too. Every string a finding carries passes through here, so
 * there is no such route left.
 *
 * It was a test for exactly that case -- a token used as a field name -- that
 * found the hole; the scanner had been careful and the unknown-field message
 * had not.
 */
export function redactCredentials(text) {
  // `renderable`, not `String`: this runs on its way into a finding, and a
  // value that cannot be turned into a string must cost its own field and no
  // more than that.
  let result = renderable(text)
  for (const { id, global } of REDACTORS) result = result.replace(global, `[redacted ${id}]`)
  return result
}

/**
 * Where each credential shape matched, and nothing about what it said.
 *
 * The return value carries the pattern id, the offset and the length. It never
 * carries the matched substring, and there is no option to ask for it.
 */
export function findCredentials(text) {
  const hits = []
  for (const { id, pattern } of CREDENTIAL_PATTERNS) {
    const match = pattern.exec(text)
    if (match === null) continue
    hits.push({ id, index: match.index, length: match[0].length })
  }
  return hits.sort((left, right) => (left.index - right.index) || (left.id < right.id ? -1 : 1))
}

/** A line that opens a conversational turn: `user:`, `Assistant >`, `tool:`. */
const TURN = /^[ \t>*-]*(?:user|assistant|system|human|ai|tool|agent)[ \t]*[:>]/i

/**
 * How many conversational turns a string looks like it contains.
 *
 * A blunt heuristic over line starts, and it is described as one. A packet is a
 * summary written for a successor; a transcript pasted into it is the failure
 * this counts. It will miss a transcript with no speaker labels, and the length
 * rule is what catches that case instead.
 */
export function countTranscriptTurns(text) {
  let turns = 0
  for (const line of text.split('\n')) {
    if (TURN.test(line)) turns += 1
  }
  return turns
}

/**
 * Every string in the document, with its JSON Pointer, bounded.
 *
 * Object keys are walked as well as values: a credential used as a key is still
 * a credential in the file. The walk is bounded by depth and by node count
 * because it runs before the schema is checked -- deliberately, so that a
 * credential hiding in a field this build does not recognise is still found --
 * and an unchecked document can be any shape at all.
 */
export function walkStrings(value, { maxDepth, maxNodes }) {
  const strings = []
  let nodes = 0

  const visit = (node, pointer, depth, isKey = false) => {
    nodes += 1
    if (nodes > maxNodes) return { ok: false, reason: 'nodes' }
    if (depth > maxDepth) return { ok: false, reason: 'depth' }
    if (typeof node === 'string') {
      strings.push({ pointer, value: node, isKey })
      return { ok: true }
    }
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) {
        const result = visit(entry, `${pointer}/${index}`, depth + 1)
        if (!result.ok) return result
      }
      return { ok: true }
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const childPointer = `${pointer}/${escapePointerSegment(key)}`
        const keyResult = visit(key, childPointer, depth + 1, true)
        if (!keyResult.ok) return keyResult
        const result = visit(node[key], childPointer, depth + 1)
        if (!result.ok) return result
      }
      return { ok: true }
    }
    return { ok: true }
  }

  const outcome = visit(value, '', 0)
  return outcome.ok ? { ok: true, strings, nodes } : { ...outcome, nodes }
}
