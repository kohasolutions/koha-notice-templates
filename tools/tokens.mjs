#!/usr/bin/env node
// Writes out/bundle.json: every notice, with Koha's own output for it, ready for a page to put a library's values in.
//
//   node tools/tokens.mjs            render the bundle
//   node tools/tokens.mjs --prove    also render every case again with real values, and compare with the bundle
//
// The contract is in TOKENS.md. Both renders go through tools/render.mjs (real Koha, rolled back).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { TRANSPORTS, casesOf, loadNotices, runKoha } from './render.mjs'
import { fillPreview, fillTemplate, tokenTemplate, variantKey, variantsOf } from './branding.mjs'

const ROOT = new URL('..', import.meta.url).pathname
export const DEFAULTS = { name: 'Riverside Library', colour: '#1f4e79' }

// Every set must come out the same through the preview and through Koha.
export const PROOF = [
  {},
  { name: 'Lahore Public Library' },
  { name: `O'Brien & "Sons" <b>Library</b>`, logo: 'https://example.org/l.png?a=1&b=2', colour: '#AB12cd', footer: 'Open 9–5 & "late" on Fridays' },
  { name: 'C:\\new\\table $x ${branch.branchname} 100%] [% y %]', footer: "tail\\$ it's #1; \\\\" },
  { name: 'کتب خانہ 図書館 📚', footer: '__LIBRARY_NAME__ __LOGO_URL__ $1 $& %%]]' },
  { name: '__FOOTER_NOTE__', logo: "https://example.org/a'b%5D$x/(1).png", footer: "'; DROP [%- x -%]" },
]

const job = (n, f, content) => ({
  code: n.code, module: n.module, file: f, transport: TRANSPORTS[f].transport, is_html: TRANSPORTS[f].is_html,
  title: n.subject, content, scenario: n.scenario, print_as: n.print_as, case: n.case,
})

function render(jobs) {
  const res = runKoha(jobs)
  if (res.leaked?.length) throw new Error(`the rollback did not hold: ${res.leaked.join(', ')}`)
  const bad = res.results.map((r, i) => [r, jobs[i]]).filter(([r]) => !r.ok)
  if (bad.length || res.results.length !== jobs.length)
    throw new Error(bad.map(([r, j]) => `${j.code} ${j.file} ${j.case}: ${r.error}`).join('\n') || 'Koha stopped early')
  return res
}

/** The slip prints the time to the minute, and two renders can be a minute apart. */
export const sameTime = (s) => s.replace(/\b(\d\d\/\d\d\/\d{4},?) \d\d:\d\d\b/g, '$1 00:00')

function main() {
  const git = (...a) => execFileSync('git', ['-C', ROOT, ...a]).toString().trim()
  const notices = loadNotices([])
  const jobs = []
  const at = []
  for (const n of notices)
    for (const f of n.files) {
      const src = readFileSync(join(n.dir, f), 'utf8')
      for (const c of casesOf(n))
        for (const v of variantsOf(src)) {
          jobs.push(job(c, f, tokenTemplate(src, v)))
          at.push({ code: n.code, file: f, case: c.case, key: variantKey(v) })
        }
    }
  const res = render(jobs)
  const bundle = {
    format: 1,
    licence: 'GPL-3.0-or-later',
    source: 'https://github.com/kohasolutions/koha-notice-templates',
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', 'notices', 'tools') !== '',
    koha: res.koha,
    defaults: DEFAULTS,
    notices: notices.map((n) => ({
      code: n.code, module: n.module, name: n.name, menu: n.menu, subject: n.subject, about: n.about,
      files: n.files.map((f) => ({
        file: f, transport: TRANSPORTS[f].transport, is_html: TRANSPORTS[f].is_html,
        template: readFileSync(join(n.dir, f), 'utf8'),
        cases: casesOf(n).map((c) => {
          const mine = at.map((a, i) => [a, res.results[i]]).filter(([a]) => a.code === n.code && a.file === f && a.case === c.case)
          return { name: c.case, defaults: { ...DEFAULTS, ...(c.prints_name && { name: c.prints_name }) }, subject: mine[0][1].subject ?? '', rendered: Object.fromEntries(mine.map(([a, r]) => [a.key, r.content])) }
        }),
      })),
    })),
  }
  mkdirSync(join(ROOT, 'out'), { recursive: true })
  const text = JSON.stringify(bundle, null, 1) + '\n'
  writeFileSync(join(ROOT, 'out', 'bundle.json'), text)
  console.log(`bundle: ${notices.length} notices, ${jobs.length} renders, ${text.length} bytes, Koha ${res.koha}, sha256 ${createHash('sha256').update(text).digest('hex')}`)
  if (!process.argv.includes('--prove')) return

  const pjobs = []
  const want = []
  for (const n of bundle.notices)
    for (const f of n.files)
      for (const c of f.cases)
        for (const [i, values] of PROOF.entries()) {
          const full = casesOf(notices.find((x) => x.code === n.code)).find((x) => x.case === c.name)
          pjobs.push(job(full, f.file, fillTemplate(f.template, values, f.is_html)))
          want.push({ id: `${n.code} ${f.file} ${c.name} values ${i}`, text: fillPreview(c.rendered, values, f.is_html, c.defaults), subject: c.subject })
        }
  const got = render(pjobs)
  let failed = 0
  got.results.forEach((r, i) => {
    if (sameTime(r.content) === sameTime(want[i].text) && (r.subject ?? '') === want[i].subject) return
    failed++
    if (failed <= 5) console.error(`DIFFERENT ${want[i].id}\n--- Koha\n${r.content}\n--- preview\n${want[i].text}`)
  })
  console.log(`proof: ${got.results.length - failed} of ${got.results.length} previews equal to Koha's output`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
