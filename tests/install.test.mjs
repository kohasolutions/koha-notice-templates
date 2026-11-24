// Unit tests for tools/install.mjs, without a Koha. tools/e2e-install.mjs is the live proof.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { blockValues, chooseFiles, diff, planOne, planRestore, splitBlock, statusOf, toSource, withValues } from '../tools/install.mjs'
import { TRANSPORTS } from '../tools/render.mjs'

const dir = new URL('../notices/', import.meta.url).pathname
const read = (c, f) => readFileSync(`${dir}${c}/${f}`, 'utf8')
const TT = read('CHECKOUT', 'email.html.tt')
const meta = { subject: 'Items', name: 'Checkout receipt' }
const key = { module: 'circulation', code: 'CHECKOUT', branchcode: '', transport: 'email' }
const row = (content, title = 'Items') => ({ id: 1, name: 'Mine', content, title, is_html: 1, updated_on: 'x' })
const plan = (found, flags = {}, force = false) => planOne({ key, meta, template: TT, isHtml: true, found, flags, force })

test('every template in the set has a block the installer can fill, and only the block changes', () => {
  for (const c of readdirSync(dir))
    for (const f of readdirSync(dir + c).filter((x) => TRANSPORTS[x])) {
      const t = read(c, f)
      assert.ok(blockValues(t).library_name, `${c} ${f}`)
      const out = withValues(t, { library_name: "'X'", brand_colour: "'#000000'", logo_url: "''", footer_note: "'F'" })
      assert.equal(splitBlock(out).rest, splitBlock(t).rest, `${c} ${f}`)
      assert.equal(blockValues(out).library_name, "'X'")
    }
})

test('a typed value is quoted for Template Toolkit, and escaped for HTML only in HTML', () => {
  assert.equal(toSource('library_name', `O'Neil & "S" \\ <b>`, true), String.raw`'O\'Neil &amp; &quot;S&quot; \\ &lt;b&gt;'`)
  assert.equal(toSource('library_name', `O'Neil & S`, false), String.raw`'O\'Neil & S'`)
  assert.equal(blockValues(withValues(TT, { library_name: String.raw`'a;b\'c; $x'` })).library_name, String.raw`'a;b\'c; $x'`)
})

test('a value that would break the notice is refused', () => {
  for (const [n, v] of [['library_name', 'a%]b'], ['library_name', 'a\nb'], ['footer_note', '----'], ['footer_note', '<<x>>'], ['brand_colour', 'red'], ['brand_colour', '#fff'], ['logo_url', 'http://x/l.png'], ['logo_url', 'https://x/"onerror=']])
    assert.throws(() => toSource(n, v, true), undefined, `${n} ${v}`)
  assert.equal(toSource('logo_url', '', true), "''")
})

test('what is in Koha decides: missing, its own text, ours, or somebody’s own', () => {
  const koha = { content: 'Koha text\r\nline', title: 'K' }
  assert.equal(plan({ row: null, default: koha }).action, 'create')
  assert.deepEqual([plan({ row: row('Koha text\nline', 'K'), default: koha }).action, plan({ row: row('Koha text\nline', 'K'), default: koha }).status], ['replace', 'koha-default'])
  const edited = { row: row('Our own text'), default: koha }
  assert.equal(plan(edited).action, 'refuse')
  assert.equal(plan(edited).set, undefined)
  assert.equal(plan(edited, {}, true).action, 'replace')
  assert.equal(plan({ row: row(TT), default: koha }).action, 'nothing')
  assert.equal(statusOf(row(TT + 'a line of their own'), koha, { content: TT, title: 'Items', is_html: 1 }, TT), 'customised')
  assert.equal(statusOf(row(TT, 'Their subject'), koha, { content: TT, title: 'Items', is_html: 1 }, TT), 'customised')
})

test('the library’s values survive an update, and a new one replaces only its own', () => {
  const branded = withValues(TT, { library_name: "'Mine'", brand_colour: "'#112233'" })
  assert.equal(plan({ row: row(branded) }).action, 'nothing')
  const p = plan({ row: row(branded) }, { brand_colour: '#445566' })
  assert.equal(p.action, 'replace')
  assert.deepEqual([blockValues(p.set.content).library_name, blockValues(p.set.content).brand_colour], ["'Mine'", "'#445566'"])
  assert.equal(p.set.name, 'Mine')
  const text = planOne({ key, meta, template: read('CHECKOUT', 'email.txt.tt'), isHtml: false, found: { row: row(withValues(TT, { library_name: "'A &amp; B'" })) }, flags: {}, force: true })
  assert.ok(!text.set.content.includes('&amp;'))
})

test('restore puts back, deletes what was not there, and refuses a notice edited since', () => {
  const before = row('old')
  const installed = { title: 'Items', content: 'new', is_html: 1 }
  const backup = { entries: [{ key, before, installed }, { key, before: null, installed }] }
  const now = row('new')
  assert.deepEqual(planRestore(backup, [{ row: now }, { row: now }]).map((p) => [p.action, p.set, p.exact]), [['put back', before, true], ['delete', null, true]])
  assert.equal(planRestore(backup, [{ row: row('edited') }, { row: now }])[0].action, 'refuse')
  assert.equal(planRestore(backup, [{ row: row('edited') }, { row: now }], true)[0].action, 'put back')
  assert.deepEqual(planRestore(backup, [{ row: before }, { row: null }]).map((p) => p.action), ['nothing', 'nothing'])
})

test('one email per notice: HTML unless --text; --transports narrows it', () => {
  const files = ['email.html.tt', 'email.txt.tt', 'sms.txt.tt', 'print.html.tt', 'notice.json']
  assert.deepEqual(chooseFiles(files, {}), ['email.html.tt', 'sms.txt.tt', 'print.html.tt'])
  assert.deepEqual(chooseFiles(files, { text: true, transports: ['email'] }), ['email.txt.tt'])
})

test('diff shows only the part that changed', () => {
  assert.deepEqual(diff('a\nb\nc', 'a\nx\nc'), ['- b', '+ x'])
  assert.deepEqual(diff('', 'a'), ['+ a'])
})
