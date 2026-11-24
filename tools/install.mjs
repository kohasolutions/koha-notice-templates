#!/usr/bin/env node
// Puts chosen notices into a Koha, and takes them out again.
//
//   node tools/install.mjs CHECKOUT ODUE                     show what would change (nothing is written)
//   node tools/install.mjs CHECKOUT ODUE --apply             write it; the originals go to backups/<date>.json first
//   node tools/install.mjs --all --library-name "My Library" --logo-url https://… --colour "#004080" --footer "Open 9-5"
//   node tools/install.mjs restore backups/<date>.json       show what would be put back
//   node tools/install.mjs restore backups/<date>.json --apply
//
//   --text              use the plain-text email instead of the HTML one
//   --transports=a,b    only these: email, sms, print
//   --branch=CPL        the notice of one library instead of "All libraries"
//   --force             also replace a notice that somebody has customised (or restore over a later edit)
//   --backup-dir=DIR    default: backups
//
// Where Koha is: on the Koha server, set KOHA_INSTANCE and run it as a user who may `sudo koha-shell`; for a Koha in
// Docker, set KOHA_CONTAINER as well. No Koha password is needed, asked for or stored.
//
// Why koha-shell and not the staff interface: the Notices form saves every transport and language of a notice at once,
// cannot write several notices in one transaction, cannot tell that somebody edited the notice in between, and cannot
// put a row back exactly (id and date). Koha's REST API has no endpoint for notices (checked in 26.05).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { TRANSPORTS } from './render.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const BLOCK = /^\[%-\s*\n\s*# ── Your library: [\s\S]*?-?%\]\n/
const VALUE = String.raw`((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[^;'"])+)`
const NAMES = ['library_name', 'logo_url', 'brand_colour', 'footer_note']
const line = (name) => new RegExp(String.raw`^(\s*${name}\s*= )${VALUE}(;)`, 'm')

const same = (s) => (s ?? '').replace(/\r\n/g, '\n').trimEnd()

/** Splits a template into its "Your library" block and the rest; block is null when it has none. */
export function splitBlock(text) {
  const t = same(text)
  const m = `${t}\n`.match(BLOCK)
  return m ? { block: m[0], rest: t.slice(m[0].length) } : { block: null, rest: t }
}

/** The values in a block, as Template Toolkit source ('My Library', branch.branchname, …). */
export function blockValues(text) {
  const { block } = splitBlock(text)
  const out = {}
  if (block) for (const n of NAMES) { const m = block.match(line(n)); if (m) out[n] = m[2].trim() }
  return out
}

/** A value the librarian typed, as a Template Toolkit string; throws when it cannot be used. */
export function toSource(name, value, isHtml) {
  if (/[\r\n]/.test(value) || value.includes('%]') || value.includes('[%') || value.includes('----') || value.includes('<<'))
    throw new Error(`${name}: no line breaks, [%, %], << or ----`)
  if (name === 'brand_colour' && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`the colour must look like #1f4e79, not "${value}"`)
  if (name === 'logo_url' && value !== '' && !/^https:\/\/[^\s"'<>]+$/.test(value)) throw new Error('the logo address must start with https://')
  let v = value
  if (isHtml) v = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** The template with other values in its block; a value the template does not have (an SMS has no logo) is skipped. */
export function withValues(template, sources) {
  const { block, rest } = splitBlock(template)
  if (!block) throw new Error('the template has no "Your library" block')
  let b = block
  for (const [n, src] of Object.entries(sources)) b = b.replace(line(n), (_, a, __, c) => a + src + c)
  return `${b}${rest}\n`
}

/** What is in Koha now, compared with Koha's own text and with ours. */
export function statusOf(row, koha, wanted, template) {
  if (!row) return 'missing'
  if (same(row.content) === same(wanted.content) && row.title === wanted.title && Number(row.is_html) === wanted.is_html) return 'installed'
  const { block, rest } = splitBlock(row.content)
  if (block && rest === splitBlock(template).rest && row.title === wanted.title) return 'ours'
  if (koha && same(row.content) === same(koha.content) && row.title === koha.title) return 'koha-default'
  return 'customised'
}

/** The change for one notice and transport, or null when there is nothing to do. */
export function planOne({ key, meta, template, isHtml, found, flags, force }) {
  // values somebody already put in our block stay, unless this run gives others
  // (a value typed for an HTML notice holds &amp; and the like, so it does not move to a text one, or back)
  const kept = Number(found.row?.is_html) === (isHtml ? 1 : 0) ? blockValues(found.row?.content) : {}
  const typed = Object.fromEntries(Object.entries(flags).map(([n, v]) => [n, toSource(n, v, isHtml)]))
  const wanted = { title: meta.subject, is_html: isHtml ? 1 : 0, content: withValues(template, { ...kept, ...typed }) }
  const status = statusOf(found.row, found.default, wanted, template)
  const base = { key, status, expect: found.row, others: found.others ?? [] }
  if (status === 'installed') return { ...base, action: 'nothing' }
  if (status === 'customised' && !force) return { ...base, action: 'refuse', wanted }
  return { ...base, action: found.row ? 'replace' : 'create', wanted, set: { ...wanted, name: found.row?.name ?? found.name ?? meta.name } }
}

/** The changes that undo a backup; refuses a row that is no longer what the install wrote. */
export function planRestore(backup, found, force) {
  return backup.entries.map((e, i) => {
    const now = found[i].row
    const untouched = now && e.installed && now.content === e.installed.content && now.title === e.installed.title && Number(now.is_html) === Number(e.installed.is_html)
    const already = JSON.stringify(now) === JSON.stringify(e.before)
    const action = already ? 'nothing' : !untouched && !force ? 'refuse' : e.before ? 'put back' : 'delete'
    return { key: e.key, action, expect: now, set: e.before, exact: true, status: untouched ? 'as installed' : 'edited since' }
  })
}

/** A small line diff: common start and end dropped, the middle shown. */
export function diff(a, b) {
  const x = same(a) === '' ? [] : same(a).split('\n')
  const y = same(b) === '' ? [] : same(b).split('\n')
  let s = 0
  while (s < x.length && s < y.length && x[s] === y[s]) s++
  let e = 0
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
  return [...x.slice(s, x.length - e).map((l) => `- ${l}`), ...y.slice(s, y.length - e).map((l) => `+ ${l}`)]
}

/** Which template files to use for a notice. */
export function chooseFiles(files, { text, transports }) {
  return files.filter((f) => {
    const t = TRANSPORTS[f]
    if (!t || (transports && !transports.includes(t.transport))) return false
    if (t.transport !== 'email') return true
    const other = t.is_html ? 'email.txt.tt' : 'email.html.tt'
    return !files.includes(other) || t.is_html !== !!text
  })
}

export function koha(request) {
  const script = join(ROOT, 'tools', 'koha-letters.pl')
  const instance = process.env.KOHA_INSTANCE
  const container = process.env.KOHA_CONTAINER
  if (!instance) throw new Error('set KOHA_INSTANCE (and KOHA_CONTAINER for a Koha in Docker)')
  if (!/^[\w-]+$/.test(instance)) throw new Error('KOHA_INSTANCE is not an instance name')
  const perl = readFileSync(script, 'utf8')
  // a temporary file of its own, removed at the end: stdin carries the request
  const remote = `/tmp/koha-letters-${process.pid}.pl`
  const run = (cmd, args, input) => execFileSync(cmd, args, { input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8')
  const prefix = container ? ['docker', 'exec', '-i', container] : ['sudo']
  const [cmd, ...pre] = prefix
  try {
    run(cmd, [...pre, 'sh', '-c', `umask 022; cat > ${remote}`], perl)
    const out = run(cmd, [...pre, 'koha-shell', instance, '-c', `cd /tmp && perl ${remote}`], JSON.stringify(request))
    const at = out.lastIndexOf('\nKNT-JSON ')
    if (at < 0) throw new Error(`Koha answered nothing: ${out.slice(-300)}`)
    return JSON.parse(out.slice(at + 10))
  } catch (e) {
    if (e.stderr) throw new Error(e.stderr.toString().trim().split('\n').slice(0, 3).join('\n') || e.message)
    throw e
  } finally {
    run(cmd, [...pre, 'rm', '-f', remote])
  }
}

function saveBackup(dir, data) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return path
}

const label = (k) => `${k.code} ${k.transport}${k.branchcode ? ` (${k.branchcode})` : ''}`

function install(codes, o) {
  const dir = join(ROOT, 'notices')
  const all = readdirSync(dir).sort()
  const wanted = o.all ? all : codes
  if (!wanted.length) throw new Error('name at least one notice, or --all')
  for (const c of wanted) if (!all.includes(c)) throw new Error(`there is no notice ${c}; there are: ${all.join(', ')}`)
  const flags = {}
  for (const [opt, name] of [['library-name', 'library_name'], ['logo-url', 'logo_url'], ['colour', 'brand_colour'], ['footer', 'footer_note']])
    if (o[opt] !== undefined) flags[name] = o[opt]
  const jobs = wanted.flatMap((c) => {
    const meta = JSON.parse(readFileSync(join(dir, c, 'notice.json'), 'utf8'))
    return chooseFiles(readdirSync(join(dir, c)), { text: o.text, transports: o.transports?.split(',') }).map((f) => {
      const t = TRANSPORTS[f]
      return {
        meta,
        isHtml: t.is_html,
        template: readFileSync(join(dir, c, f), 'utf8'),
        key: { module: meta.module, code: c, branchcode: o.branch ?? '', transport: t.transport === 'print' ? (meta.print_as ?? 'email') : t.transport },
      }
    })
  })
  const found = koha({ op: 'read', keys: jobs.map((j) => j.key) })
  const plan = jobs.map((j, i) => planOne({ ...j, found: found.rows[i], flags, force: o.force }))
  for (const p of plan) {
    console.log(`${label(p.key)}: ${p.action}${p.action === 'nothing' ? ' (already installed)' : ` (now: ${p.status})`}`)
    if (p.wanted) for (const l of diff(`${p.expect?.title ?? ''}\n${p.expect?.content ?? ''}`, `${p.wanted.title}\n${p.wanted.content}`)) console.log(`    ${l}`)
    for (const x of p.others) console.log(`    note: ${x.branchcode || 'All libraries'} / ${x.lang} has its own text, which Koha uses first; it is not changed`)
  }
  return finish(plan, o, () =>
    plan.filter((p) => p.set).map((p) => ({ key: p.key, before: p.expect, installed: { title: p.set.title, content: p.set.content, is_html: p.set.is_html } })), found.koha)
}

function finish(plan, o, entries, version) {
  const refused = plan.filter((p) => p.action === 'refuse')
  const todo = plan.filter((p) => p.action !== 'nothing' && p.action !== 'refuse')
  for (const p of refused) console.error(`REFUSED ${label(p.key)}: somebody has changed this notice. --force replaces it.`)
  if (refused.length) return 1 // all or nothing
  if (!o.apply) {
    console.log(`\nDry run: nothing was written. ${todo.length} change(s); add --apply to make them.`)
    return 0
  }
  if (!todo.length) return 0
  if (entries) console.log(`\nThe originals are saved in ${saveBackup(o['backup-dir'] ?? 'backups', { koha: version, at: new Date().toISOString(), entries: entries() })}`)
  koha({ op: 'write', changes: todo.map(({ key, expect, set, exact }) => ({ key, expect, set, exact: !!exact })) })
  console.log(`${todo.length} change(s) written.`)
  return 0
}

function restore(path, o) {
  if (!path || !existsSync(path)) throw new Error('restore needs a backup file')
  const backup = JSON.parse(readFileSync(path, 'utf8'))
  const found = koha({ op: 'read', keys: backup.entries.map((e) => e.key) })
  const plan = planRestore(backup, found.rows, o.force)
  for (const p of plan) console.log(`${label(p.key)}: ${p.action} (${p.status})`)
  return finish(plan, o)
}

export function run(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: Object.fromEntries([
      ...['apply', 'force', 'text', 'all'].map((n) => [n, { type: 'boolean' }]),
      ...['transports', 'branch', 'backup-dir', 'library-name', 'logo-url', 'colour', 'footer'].map((n) => [n, { type: 'string' }]),
    ]),
  })
  return positionals[0] === 'restore' ? restore(positionals[1], o) : install(positionals, o)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = run(process.argv.slice(2))
  } catch (e) {
    console.error(`[install] ${e.message}`)
    process.exitCode = 2
  }
}
