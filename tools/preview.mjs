#!/usr/bin/env node
// Draws the previews in notices/<CODE>/ from what Koha really produced (out/, written by tools/render.mjs).
//
//   node tools/render.mjs && node tools/preview.mjs            every notice: check, then draw
//   node tools/preview.mjs --check                             only the checks, no pictures
//   node tools/preview.mjs HOLD ODUE                           only these
//   PLAYWRIGHT_FROM=/path/to/a/project                         a project with Playwright and its Chromium installed
//
// Pictures: preview-phone.png and preview-desktop.png (HTML email), preview-sms.png, preview-print.png (80 mm slip or
// A4 letter), and preview-phone-<case>.png for each case notice.json names in "previews".
// Before drawing, EVERY HTML output (all cases, not only the pictured ones) is checked; any problem exits 1:
//   - wider than a 320 px phone (80 mm for a slip), an image that did not load, text below WCAG AA contrast;
//   - an output older than its template, or one that failed or is missing in out/results.json.
// The network is blocked: a notice must look right without it. Python's Pillow, when present, shrinks the PNGs.
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { TRANSPORTS, casesOf } from './render.mjs'

const ROOT = new URL('..', import.meta.url).pathname

/** The name render.mjs gives an output: the first case keeps the plain name. */
export function outputName(file, kase) {
  const base = file.replace(/\.tt$/, '')
  return kase.plain ? base : base.replace(/\.(\w+)$/, `.${kase.case}.$1`)
}

export const isSlip = (code) => /SLIP$/.test(code)

/** The pictures of one notice: [{ kind, from, to }]. Throws when "previews" names a case that does not exist. */
export function previewsOf(notice, files) {
  const cases = casesOf(notice)
  const plain = cases.find((c) => c.plain)
  const list = []
  const add = (kind, file, kase, to) => list.push({ kind, from: outputName(file, kase), to })
  if (files.includes('email.html.tt')) {
    add('phone', 'email.html.tt', plain, 'preview-phone.png')
    add('desktop', 'email.html.tt', plain, 'preview-desktop.png')
  }
  if (files.includes('sms.txt.tt')) add('sms', 'sms.txt.tt', plain, 'preview-sms.png')
  if (files.includes('print.html.tt')) add(isSlip(notice.code) ? 'slip' : 'letter', 'print.html.tt', plain, 'preview-print.png')
  for (const name of notice.previews ?? []) {
    const kase = cases.find((c) => c.case === name)
    if (!kase) throw new Error(`${notice.code}: "previews" names "${name}", which is not one of its cases`)
    if (files.includes('email.html.tt')) add('phone', 'email.html.tt', kase, `preview-phone-${name}.png`)
  }
  return list
}

/** Why an output may not be pictured: not produced, not passed, or produced before the template last changed. */
export function outputProblems({ result, outTime, sourceTimes }) {
  if (!result) return ['not in out/results.json: run node tools/render.mjs']
  if (!result.ok) return ['failed the Koha test']
  if (outTime == null) return ['no output file']
  if (sourceTimes.some((t) => t > outTime)) return ['older than its template or notice.json: run node tools/render.mjs']
  return []
}

// Runs in the page: what is wrong with the notice in #n at this width.
/* c8 ignore start */
export function inspect(width) {
  const bad = []
  const root = document.getElementById('n')
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.right > width + 0.5) { bad.push(`wider than ${width} px: <${el.tagName.toLowerCase()}> ends at ${Math.round(r.right)} px`); break }
  }
  if (!bad.length && document.documentElement.scrollWidth > width) bad.push(`wider than ${width} px (${document.documentElement.scrollWidth} px)`)
  for (const i of root.querySelectorAll('img')) if (!i.complete || !i.naturalWidth) bad.push(`an image did not load: ${i.getAttribute('src')}`)
  const rgb = (s) => { const m = s.match(/[\d.]+/g).map(Number); return { c: m.slice(0, 3), a: m[3] ?? 1 } }
  const lum = (c) => c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0)
  const over = (top, under) => top.c.map((v, i) => v * top.a + under[i] * (1 - top.a))
  const seen = new Set()
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walk.nextNode()) {
    const text = walk.currentNode.data.trim()
    if (!text) continue
    const st = getComputedStyle(walk.currentNode.parentElement)
    const layers = []
    for (let e = walk.currentNode.parentElement; e; e = e.parentElement) layers.unshift(rgb(getComputedStyle(e).backgroundColor))
    const bg = layers.reduce((u, l) => over(l, u), [255, 255, 255])
    const [a, b] = [lum(over(rgb(st.color), bg)), lum(bg)].sort((x, y) => y - x)
    const ratio = (a + 0.05) / (b + 0.05)
    const px = parseFloat(st.fontSize)
    const need = px >= 24 || (px >= 18.66 && Number(st.fontWeight) >= 700) ? 3 : 4.5
    const key = `${st.color}/${bg}`
    if (ratio < need && !seen.has(key)) { seen.add(key); bad.push(`contrast ${ratio.toFixed(2)}:1 (needs ${need}:1): "${text.slice(0, 40)}"`) }
  }
  return bad
}
/* c8 ignore stop */

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const doc = (css, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#fff}${css}</style><body>${body}</body></html>`
const FRAME = `body{background:#eceff1;padding:20px;font-family:Arial,Helvetica,sans-serif}
.f{background:#fff;border:1px solid #cfd6da;border-radius:10px;overflow:hidden}.s{padding:12px 16px;border-bottom:1px solid #dfe4e7;font-size:15px;font-weight:bold;color:#1a1a1a}
#n{padding:16px}`

/** The page of one picture: the notice as Koha made it, in a plain frame. */
export function pageOf(kind, text, subject) {
  if (kind === 'sms')
    return doc(`body{background:#eceff1;padding:20px;font-family:Arial,Helvetica,sans-serif}#n{background:#fff;border:1px solid #cfd6da;border-radius:14px;padding:12px 14px;font-size:16px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere;color:#1a1a1a}`, `<div id="n">${esc(text.trim())}</div>`)
  if (kind === 'slip') return doc(`body{background:#eceff1;padding:16px}#n{width:80mm;margin:auto;background:#fff;padding:4mm;border:1px solid #cfd6da}`, `<div id="n">${text}</div>`)
  if (kind === 'letter') return doc(`body{background:#eceff1;padding:16px}#n{width:210mm;min-height:297mm;margin:auto;background:#fff;padding:20mm;border:1px solid #cfd6da}`, `<div id="n">${text}</div>`)
  return doc(FRAME, `<div class="f"><div class="s">${esc(subject.trim())}</div><div id="n">${text}</div></div>`)
}

const WIDTH = { phone: 390, desktop: 740, sms: 390, slip: 340, letter: 830 }

function playwright() {
  for (const from of [process.env.PLAYWRIGHT_FROM, ROOT].filter(Boolean))
    try {
      return createRequire(join(from, 'package.json'))('playwright')
    } catch { /* try the next one */ }
  console.error('[preview] Playwright is needed: npm i -D playwright, or PLAYWRIGHT_FROM=<a project that has it>')
  process.exit(2)
}

function shrink(files) {
  const py = 'import sys\nfrom PIL import Image\nfor p in sys.argv[1:]:\n Image.open(p).convert("RGB").quantize(48, dither=Image.Dither.NONE).save(p, optimize=True)'
  try {
    execFileSync('python3', ['-c', py, ...files], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch {
    console.error('[preview] Pillow not available: the pictures are not compressed')
  }
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const only = args.filter((a) => !a.startsWith('--'))
  if (!existsSync(join(ROOT, 'out', 'results.json'))) throw new Error('no out/results.json: run node tools/render.mjs first')
  const results = JSON.parse(readFileSync(join(ROOT, 'out', 'results.json'), 'utf8')).results
  const codes = readdirSync(join(ROOT, 'notices')).filter((c) => !only.length || only.includes(c)).sort()
  if (!codes.length) throw new Error(`no notices match ${only.join(' ')}`)
  const { chromium } = playwright()
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ offline: true, deviceScaleFactor: 1 })).newPage()
  await page.route('**', (r) => r.abort())
  const show = async (width, html) => {
    await page.setViewportSize({ width, height: 60 })
    await page.setContent(html)
  }
  let failed = 0, checked = 0
  const drawn = []
  for (const code of codes) {
    const dir = join(ROOT, 'notices', code)
    const notice = JSON.parse(readFileSync(join(dir, 'notice.json'), 'utf8'))
    const files = readdirSync(dir).filter((f) => TRANSPORTS[f])
    const time = (p) => (existsSync(p) ? statSync(p).mtimeMs : null)
    const problems = []
    for (const file of files)
      for (const kase of casesOf(notice)) {
        const name = outputName(file, kase)
        const out = join(ROOT, 'out', code, name)
        const p = outputProblems({
          result: results.find((r) => r.code === code && r.file === file && (r.case ?? '') === kase.case),
          outTime: time(out),
          sourceTimes: [time(join(dir, file)), time(join(dir, 'notice.json'))],
        })
        if (!p.length && TRANSPORTS[file].is_html) {
          const slip = file.startsWith('print') && isSlip(code)
          const width = slip ? 302 : 320 // 80 mm; the narrowest phone in use
          await show(width, doc(`#n{padding:${slip ? 0 : 16}px}`, `<div id="n">${readFileSync(out, 'utf8')}</div>`))
          p.push(...(await page.evaluate(inspect, width)))
        }
        checked++
        problems.push(...p.map((x) => `${name}: ${x}`))
      }
    if (!problems.length && !check)
      for (const v of previewsOf(notice, files)) {
        const out = join(ROOT, 'out', code, v.from)
        await show(WIDTH[v.kind], pageOf(v.kind, readFileSync(out, 'utf8'), readFileSync(`${out}.subject.txt`, 'utf8')))
        const to = join(dir, v.to)
        writeFileSync(to, await page.screenshot({ fullPage: true }))
        drawn.push(to)
      }
    if (problems.length) failed++
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${code}${problems.map((x) => `\n       ${x}`).join('')}`)
  }
  await browser.close()
  if (drawn.length) shrink(drawn)
  const kb = Math.round(drawn.reduce((t, f) => t + statSync(f).size, 0) / 1024)
  console.log(`\n${checked} outputs checked, ${failed} notices with problems, ${drawn.length} pictures (${kb} KB)`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(2) })
