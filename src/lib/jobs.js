/** Plugin-side projections over FastCtx's text protocol. Never adopt foreign IDs. */
const ID = 'j-[a-z0-9]{6}'
const ENTRY = new RegExp(`^(${ID}) (?:running \\d+(?:s|m\\d+s|h\\d+m)|exited -?\\d+|killed|interrupted)$`)

export function startedJob(value) {
  for (const block of value.content ?? []) {
    if (block.type !== 'text') continue
    const match = /(?:^|\n)\(Complete: job (j-[a-z0-9]{6}) started; log at [^\n]*\.\)\s*$/.exec(block.text)
    if (match) return match[1]
  }
}

/** Only touch the final server decoration, never arbitrary lines in command output. */
export function cleanBackground(value, owned) {
  const content = [...value.content]
  const index = content.findLastIndex(block => block?.type === 'text')
  if (index < 0) return value
  const block = content[index]
  const text = block.text
  if (typeof text !== 'string') return value
  const match = /(?:^|\n)\(Background: ([^\n]*)\.\)(?=\s*(?:\((?:Complete|Partial|Killed):[^\n]*\))?\s*$)/.exec(text)
  if (!match) return value
  const entries = match[1].split(', ')
  if (!entries.every(entry => ENTRY.test(entry)) && !/^\d+ jobs? running$/.test(match[1])) return value
  const kept = entries.filter(entry => {
    const parsed = ENTRY.exec(entry)
    return parsed && owned.has(parsed[1])
  })
  const replacement = kept.length ? `${match[0].startsWith('\n') ? '\n' : ''}(Background: ${kept.join(', ')}.)` : ''
  content[index] = { ...block, text: text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length) }
  return { ...value, content }
}

/** Parse only the upstream job-list entry boundaries, not arbitrary output text. */
export function jobEntries(value) {
  const text = value.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
  const entries = []
  const regex = /(?:^|\n\n)(j-[a-z0-9]{6})  (running|killed|exited -?\d+|interrupted); started ([^\n]*)\n  ([^\n]*)/g
  for (const match of text.matchAll(regex)) entries.push({ id: match[1], status: match[2], text: match[0].trimStart() })
  const next = /\(Partial:[^\n]*\boffset[=: ]+(\d+)/.exec(text)
  return { entries, next: next ? Number(next[1]) : undefined, partial: /(?:^|\n)\(Partial:/.test(text) }
}
