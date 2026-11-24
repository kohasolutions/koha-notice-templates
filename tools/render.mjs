#!/usr/bin/env node
// Runs every notice through a real Koha and checks what Koha produced.
//
//   node tools/render.mjs                    every notice
//   node tools/render.mjs CHECKOUT ISSUESLIP  only these
//   KOHA_CONTAINER=koha-koha-1 KOHA_INSTANCE=kohadev   (defaults: a koha-testing-docker Koha)
//
// For each template it:
//   1. wraps every printed value ([% x %]) in two invisible markers, so a value that comes out EMPTY shows up as
//      an empty pair, inside loops too (Template Toolkit prints nothing for an unknown name and does not complain);
//   2. sends it to tools/koha-render.pl inside the Koha container, which saves it as the notice, makes the real
//      event happen (checkout, check-in, slip) with Koha's own code and rolls everything back;
//   3. fails on a Koha error, an empty value, a left-over [% %] tag, a missing expected text, or a wrong digest;
//   4. saves Koha's output (markers removed) in out/<CODE>/<file>, the source of the previews.
// Exit code 0 only when every notice passed. Writes out/results.json.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const CONTAINER = process.env.KOHA_CONTAINER || 'koha-koha-1'
const INSTANCE = process.env.KOHA_INSTANCE || 'kohadev'
const OPEN = '⁠⁣' // word joiner + invisible separator: never in a real notice
const CLOSE = '⁣⁠'

// The file name says how Koha sends it.
export const TRANSPORTS = {
  'email.html.tt': { transport: 'email', is_html: true },
  'email.txt.tt': { transport: 'email', is_html: false },
  'sms.txt.tt': { transport: 'sms', is_html: false },
  'print.html.tt': { transport: 'print', is_html: true },
}

const DIRECTIVE = /^(IF|ELSIF|ELSE|END|UNLESS|FOREACH|FOR|WHILE|SET|USE|INCLUDE|PROCESS|BLOCK|FILTER|CALL|NEXT|LAST|RETURN|STOP|SWITCH|CASE|TRY|CATCH|THROW|MACRO|DEFAULT|INSERT|WRAPPER|PERL|RAWPERL|META|CLEAR)\b|^#|^\w+\s*=[^=]/

/** Wrap each printing [% … %] tag in markers; directives and comments are left alone. */
export function markValues(tt) {
  return tt.replace(/\[%([-+~=]?)([\s\S]*?)([-+~=]?)%\]/g, (tag, open, body, close) => {
    const b = body.trim()
    if (b === '' || DIRECTIVE.test(b) || b.includes(';')) return tag
    return `${OPEN}${tag}${CLOSE}`
  })
}

export function unmark(s) {
  return s.split(OPEN).join('').split(CLOSE).join('')
}

export function checkOutput(notice, file, out) {
  const problems = []
  const content = out.content ?? ''
  const subject = out.subject ?? ''
  for (const [where, text] of [['content', content], ['subject', subject]]) {
    const empties = text.split(OPEN + CLOSE).length - 1
    if (empties) problems.push(`${empties} value(s) printed empty in the ${where}`)
    if (/\[%|%\]/.test(unmark(text))) problems.push(`a Template Toolkit tag was left in the ${where}`)
  }
  const clean = unmark(content)
  if (TRANSPORTS[file].transport === 'sms') {
    // an SMS carries no barcodes: one "- title" line per item instead
    const lines = clean.split('\n').filter((l) => l.startsWith('- ')).length
    if (notice.digest && lines !== 2) problems.push(`the SMS lists ${lines} items, expected 2`)
  } else {
    for (const e of notice.expect ?? []) if (!clean.includes(e)) problems.push(`expected "${e}" in the output`)
  }
  if (notice.digest) {
    // One message for the visit: the greeting (header) once, and the footer once, whatever the item count.
    const count = (s) => clean.split(s).length - 1
    if (file !== 'sms.txt.tt' && count('Jane') !== 1) problems.push(`the greeting appears ${count('Jane')} times: check the two ---- lines`)
    if (count('Riverside Library') > (file === 'sms.txt.tt' ? 1 : 3)) problems.push('the header or footer was repeated: check the two ---- lines')
    if (/^-{4}/m.test(clean)) problems.push('a ---- line reached the patron')
  }
  if (TRANSPORTS[file].transport === 'sms' && clean.length > 320) problems.push(`SMS is ${clean.length} characters (over 2 parts)`)
  if (/\n\s*\n\s*\n/.test(clean) && !TRANSPORTS[file].is_html) problems.push('more than one blank line in a row')
  return problems
}

function loadNotices(only) {
  const dir = join(ROOT, 'notices')
  return readdirSync(dir)
    .filter((c) => !only.length || only.includes(c))
    .sort()
    .map((code) => {
      const meta = JSON.parse(readFileSync(join(dir, code, 'notice.json'), 'utf8'))
      const files = readdirSync(join(dir, code)).filter((f) => TRANSPORTS[f]).sort()
      return { ...meta, dir: join(dir, code), files }
    })
}

function runKoha(jobs) {
  const script = join(ROOT, 'tools', 'koha-render.pl')
  const remote = `/tmp/koha-render-${process.pid}.pl` // its own name: two runs may share a container
  execFileSync('docker', ['cp', script, `${CONTAINER}:${remote}`])
  const out = execFileSync(
    'docker',
    // koha-shell starts a new login shell as the instance user, which drops the caller's environment: the variable
    // must be set INSIDE the command. koha-render.pl refuses to run without it.
    ['exec', '-i', CONTAINER, 'koha-shell', INSTANCE, '-c', `cd /tmp && KOHA_TESTING=1 perl ${remote}`],
    { input: JSON.stringify({ notices: jobs }), maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
  ).toString('utf8')
  return JSON.parse(out.slice(out.indexOf('{')))
}

async function main() {
  const only = process.argv.slice(2)
  const notices = loadNotices(only)
  if (!notices.length) throw new Error(`no notices match ${only.join(' ')}`)
  const jobs = []
  for (const n of notices)
    for (const f of n.files)
      jobs.push({
        code: n.code,
        module: n.module,
        file: f,
        transport: TRANSPORTS[f].transport,
        is_html: TRANSPORTS[f].is_html,
        title: markValues(n.subject),
        content: markValues(readFileSync(join(n.dir, f), 'utf8')),
        scenario: n.scenario,
      })
  const res = runKoha(jobs)
  if (res.leaked?.length) {
    console.error(`STOP: the rollback did not hold, Koha still has: ${res.leaked.join(', ')}. Remove them by hand.`)
    process.exit(3)
  }
  let failed = 0
  const summary = []
  res.results.forEach((r, i) => {
    const job = jobs[i]
    const notice = notices.find((n) => n.code === job.code)
    const problems = r.ok ? checkOutput(notice, job.file, r) : [`Koha: ${r.error}`]
    const outDir = join(ROOT, 'out', job.code)
    mkdirSync(outDir, { recursive: true })
    if (r.ok) {
      writeFileSync(join(outDir, job.file.replace(/\.tt$/, '')), unmark(r.content))
      writeFileSync(join(outDir, job.file.replace(/\.tt$/, '.subject.txt')), unmark(r.subject ?? '') + '\n')
    }
    const ok = problems.length === 0
    if (!ok) failed++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${job.code} ${job.file}${ok ? '' : '\n       ' + problems.join('\n       ')}`)
    summary.push({ code: job.code, file: job.file, ok, problems, sample: r.sample ?? null })
  })
  writeFileSync(join(ROOT, 'out', 'results.json'), JSON.stringify({ koha: res.koha, at: new Date().toISOString(), results: summary }, null, 2) + '\n')
  console.log(`\nKoha ${res.koha}: ${summary.length - failed} of ${summary.length} passed`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}` && existsSync(join(ROOT, 'notices'))) {
  main().catch((e) => {
    console.error(e.stderr ? e.stderr.toString() : e)
    process.exit(2)
  })
}
