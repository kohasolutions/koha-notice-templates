#!/usr/bin/env node
// Checks every notice folder without a Koha — run in CI on each push, and before every commit.
//
//   node tools/lint.mjs
//
// The live proof that a notice works in Koha is tools/render.mjs; this catches the rest:
//   - notice.json has every field, and the folder has at least one template;
//   - every template starts with the "Your library" block (the one place a library edits, and the only part the
//     live builder changes);
//   - a digest notice (CHECKOUT, CHECKIN) has exactly two ---- lines, and no other notice has any (Koha splits a
//     notice on ---- even inside text, so a stray one breaks it);
//   - no image or stylesheet is loaded from anywhere but the library's own logo_url;
//   - Template Toolkit can parse every template (tools/tt-parse.pl, run when Perl's Template module is installed).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { TRANSPORTS } from './render.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const REQUIRED = ['code', 'module', 'name', 'menu', 'subject', 'scenario', 'digest', 'about']

export function problemsOf(code, meta, files) {
  const p = []
  for (const k of REQUIRED) if (!(k in meta)) p.push(`notice.json has no "${k}"`)
  if (meta.code !== code) p.push(`notice.json says code "${meta.code}", the folder is "${code}"`)
  const tts = Object.keys(files)
  if (!tts.length) p.push('no template (email.html.tt, email.txt.tt, sms.txt.tt or print.html.tt)')
  for (const [f, text] of Object.entries(files)) {
    if (!/^\[%-\s*\n\s*# ── Your library: /.test(text)) p.push(`${f}: does not start with the "Your library" block`)
    const seps = text.split('\n').filter((l) => l.trim() === '----').length
    if (meta.digest && seps !== 2) p.push(`${f}: a digest notice needs exactly two ---- lines, found ${seps}`)
    if (!meta.digest && /----/.test(text)) p.push(`${f}: has "----", which Koha treats as a digest separator`)
    for (const m of text.matchAll(/(?:src|href)="([^"[]+)"/g))
      if (/^(https?:)?\/\//.test(m[1])) p.push(`${f}: loads ${m[1]} — only the library's own logo_url may be loaded`)
    if (/<link\b|@import/.test(text)) p.push(`${f}: loads a stylesheet; use inline styles (mail apps drop them)`)
    if (/<html\b|<body\b|<head\b/.test(text)) p.push(`${f}: has <html>/<head>/<body>; Koha adds those when it sends`)
  }
  return p
}

function main() {
  const dir = join(ROOT, 'notices')
  let failed = 0
  const all = []
  for (const code of readdirSync(dir).sort()) {
    const metaPath = join(dir, code, 'notice.json')
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {}
    const files = Object.fromEntries(
      readdirSync(join(dir, code))
        .filter((f) => TRANSPORTS[f])
        .map((f) => [f, readFileSync(join(dir, code, f), 'utf8')]),
    )
    for (const f of Object.keys(files)) all.push(join(dir, code, f))
    const p = problemsOf(code, meta, files)
    if (p.length) {
      failed++
      console.error(`✗ ${code}`)
      for (const x of p) console.error(`    ${x}`)
    }
  }
  let parsed = 'Template Toolkit parse skipped (install libtemplate-perl)'
  try {
    execFileSync('perl', ['-MTemplate', '-e', '1'], { stdio: 'ignore' })
    execFileSync('perl', [join(ROOT, 'tools', 'tt-parse.pl'), ...all], { stdio: 'inherit' })
    parsed = `${all.length} templates parsed by Template Toolkit`
  } catch (e) {
    if (e.status === 1) {
      failed++
      parsed = 'Template Toolkit found syntax errors (above)'
    }
    else if (process.env.CI) {
      console.error('[lint] Perl Template Toolkit is required in CI')
      failed++
    }
  }
  console.log(`[lint] ${readdirSync(dir).length} notices, ${failed} with problems; ${parsed}.`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
