#!/usr/bin/env node
// The whole install, on a real Koha, for a TEST Koha only:
//   install CHECKOUT (and WELCOME and ODUE, to cover a row that did not exist) → check two items out to a patron made for
//   it → read the message Koha queued → restore → compare every table of the database with how it was.
//   KOHA_CONTAINER=koha-koha-1 KOHA_INSTANCE=kohadev node tools/e2e-install.mjs --i-know-this-is-a-test-koha
// It holds the same lock as tools/render.mjs. Nothing is sent: process_message_queue.pl is never run.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './install.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const C = process.env.KOHA_CONTAINER || 'koha-koha-1'
const I = process.env.KOHA_INSTANCE || 'kohadev'
process.env.KOHA_CONTAINER = C
process.env.KOHA_INSTANCE = I
if (!process.argv.includes('--i-know-this-is-a-test-koha')) {
  console.error('This checks items out in the Koha it is pointed at. Add --i-know-this-is-a-test-koha.')
  process.exit(2)
}
const remote = `/tmp/koha-e2e-${process.pid}.pl`
const args = (mode) => ['exec', '-i', C, 'koha-shell', I, '-c', `cd /tmp && perl ${remote} ${mode}`]
const perl = (mode) => {
  const out = execFileSync('docker', args(mode), { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  return JSON.parse(out.slice(out.indexOf('KNT-JSON ') + 9))
}
const checks = []
const check = (what, ok, more = '') => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` ${more}`}`) }
const NAME = `O'Neil & Sons "Library"; main`

execFileSync('docker', ['cp', '-q', join(ROOT, 'tools/koha-e2e.pl'), `${C}:${remote}`])
const lock = spawn('docker', args('lock'), { stdio: ['pipe', 'pipe', 'ignore'] })
const held = await new Promise((r) => lock.stdout.on('data', (d) => r(d.toString().trim())))
if (held !== 'locked') { console.error('another run is using this Koha'); process.exit(2) }

const backups = mkdtempSync(join(tmpdir(), 'knt-e2e-'))
const common = ['--backup-dir', backups]
const quiet = (argv) => { const l = console.log; console.log = () => {}; try { return run(argv) } finally { console.log = l } }
const before = perl('snapshot')
let installed = false
try {
  check('a dry run writes nothing', quiet(['CHECKOUT', 'WELCOME', 'ODUE']) === 0 && perl('snapshot').tables.letter === before.tables.letter)
  check('install', quiet(['CHECKOUT', 'WELCOME', 'ODUE', '--apply', '--library-name', NAME, '--colour', '#0a7a3c', '--footer', 'Open 9–5', ...common]) === 0)
  installed = true
  check('the notices changed', perl('snapshot').tables.letter !== before.tables.letter)
  check('installing again changes nothing, and keeps the library’s values', (() => {
    const x = perl('snapshot').tables.letter
    return quiet(['CHECKOUT', 'WELCOME', 'ODUE', '--apply', ...common]) === 0 && perl('snapshot').tables.letter === x && readdirSync(backups).length === 1
  })())
  const r = perl('checkout')
  check('the checkout worked', !r.error, r.error)
  check('Koha queued one message for the visit', r.messages?.length === 1, JSON.stringify(r.messages?.length))
  const m = r.messages?.[0] ?? { content: '', subject: '' }
  check('it is our text, with our two loans', m.content.includes('You borrowed these items.') && m.content.includes('KNT-E2E-ITEM-1') && m.content.includes('KNT-E2E-ITEM-2'))
  check('with the library’s name, colour and footer', m.content.includes('O\'Neil &amp; Sons &quot;Library&quot;; main') && m.content.includes('#0a7a3c') && m.content.includes('Open 9–5'))
  check('no tag and no separator reached the message', !/\[%|----/.test(m.content))
  check('the subject is ours, with Koha’s library name', m.subject === `Items you borrowed from ${r.library}`, m.subject)
  check('it was queued, not sent', m.status === 'pending', m.status)
  console.log(`     made and deleted: patron ${r.cleanup.patron}, items ${r.cleanup.items}, loans ${r.cleanup.loans}; ${JSON.stringify(r.cleanup.deleted)}`)
} finally {
  perl(`cleanup ${before.log}`)
  if (installed) {
    const [file] = readdirSync(backups)
    check('restore', quiet(['restore', join(backups, file), '--apply']) === 0)
  }
  const after = perl('snapshot')
  const diff = Object.keys(before.tables).filter((t) => before.tables[t] !== after.tables[t])
  check(`every one of the ${Object.keys(before.tables).length} tables is as it was`, diff.filter((t) => t !== 'sessions').length === 0, diff.map((t) => `${t} ${before.tables[t]} -> ${after.tables[t]}`).join(', '))
  const drift = Object.keys(before.next).filter((t) => before.next[t] !== after.next[t])
  console.log(`     counters that moved on (no data): ${drift.map((t) => `${t} ${before.next[t]} -> ${after.next[t]}`).join(', ') || 'none'}`)
  if (diff.includes('letter')) console.error(`letter differs: the originals are in ${backups}`)
  lock.stdin.end()
  execFileSync('docker', ['exec', C, 'rm', '-f', remote])
}
process.exit(checks.every(Boolean) ? 0 : 1)
