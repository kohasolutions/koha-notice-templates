#!/usr/bin/env node
// Writes TESTED.md from out/results.json (tools/render.mjs). Refuses when a check failed, or when any notice, format
// or case in notices/ is missing from the results.
//
//   node tools/render.mjs && node tools/tested.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSPORTS, casesOf } from './render.mjs'

const ROOT = new URL('..', import.meta.url).pathname

/** notices: [{ …notice.json, files }]. Returns the reasons not to write. */
export function reasonsNot(data, notices) {
  const why = data.results.filter((r) => !r.ok).map((r) => `${r.code} ${r.file}${r.case ? ` (${r.case})` : ''} failed`)
  if (!notices.length) why.push('there are no notices')
  if (!data.koha) why.push('the results do not say which Koha')
  for (const n of notices)
    for (const file of n.files)
      for (const c of casesOf(n))
        if (!data.results.some((r) => r.code === n.code && r.file === file && (r.case ?? '') === c.case))
          why.push(`${n.code} ${file}${c.case ? ` (${c.case})` : ''} was not run`)
  return why
}

const FORMAT = { 'email.html.tt': 'email (HTML)', 'email.txt.tt': 'email (text)', 'sms.txt.tt': 'SMS', 'print.html.tt': 'print' }

export function testedMarkdown(data, notices) {
  const rows = notices.map((n) => {
    const cases = casesOf(n).map((c) => c.case).filter(Boolean)
    const runs = data.results.filter((r) => r.code === n.code).length
    return `| \`${n.code}\` | ${n.files.map((f) => FORMAT[f]).join(', ')} | ${cases.map((c) => c.replace(/_/g, ' ')).join(', ') || '—'} | ${runs} of ${runs} |`
  })
  return `# Tested

Written by \`tools/tested.mjs\` from a run of \`tools/render.mjs\`; never edited by hand.

- **Koha:** ${data.koha}
- **Date:** ${data.at.slice(0, 10)}
- **Result:** ${data.results.length} of ${data.results.length} checks passed

Each check saves the template as the notice in a running Koha, makes the real event happen with Koha's own code, reads
the message Koha made and rolls everything back.

| Notice | Formats | Situations | Passed |
|---|---|---|---|
${rows.join('\n')}
`
}

function main() {
  const data = JSON.parse(readFileSync(join(ROOT, 'out', 'results.json'), 'utf8'))
  const dir = join(ROOT, 'notices')
  const notices = readdirSync(dir).sort().map((code) => ({
    ...JSON.parse(readFileSync(join(dir, code, 'notice.json'), 'utf8')),
    files: readdirSync(join(dir, code)).filter((f) => TRANSPORTS[f]).sort(),
  }))
  const why = reasonsNot(data, notices)
  if (why.length) {
    console.error(`[tested] TESTED.md not written:\n  ${why.join('\n  ')}`)
    process.exit(1)
  }
  writeFileSync(join(ROOT, 'TESTED.md'), testedMarkdown(data, notices))
  console.log(`[tested] TESTED.md: Koha ${data.koha}, ${data.results.length} checks`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
