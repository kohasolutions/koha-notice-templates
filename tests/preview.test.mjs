import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { previewsOf, outputName, outputProblems, pageOf } from '../tools/preview.mjs'
import { reasonsNot, testedMarkdown } from '../tools/tested.mjs'
import { casesOf } from '../tools/render.mjs'

const odue = { code: 'ODUE', cases: [{ name: 'no_fine' }, { name: 'fine' }], previews: ['fine'] }
const files = ['email.html.tt', 'email.txt.tt', 'sms.txt.tt', 'print.html.tt']

test('the plain case is pictured in every format, and a named case on the phone', () => {
  assert.deepEqual(previewsOf(odue, files).map((p) => `${p.kind} ${p.from} ${p.to}`), [
    'phone email.html preview-phone.png',
    'desktop email.html preview-desktop.png',
    'sms sms.txt preview-sms.png',
    'letter print.html preview-print.png',
    'phone email.fine.html preview-phone-fine.png',
  ])
})

test('a slip is pictured as a slip; a case that does not exist is refused', () => {
  assert.deepEqual(previewsOf({ code: 'ISSUESLIP' }, ['print.html.tt']).map((p) => p.kind), ['slip'])
  assert.throws(() => previewsOf({ ...odue, previews: ['nope'] }, files), /nope/)
})

test('outputName follows render.mjs', () => {
  const [a, b] = casesOf(odue)
  assert.deepEqual([outputName('email.html.tt', a), outputName('email.html.tt', b)], ['email.html', 'email.fine.html'])
})

test('an output that is missing, failed or stale is not pictured', () => {
  const ok = { result: { ok: true }, outTime: 10, sourceTimes: [9, 10] }
  assert.deepEqual(outputProblems(ok), [])
  assert.match(outputProblems({ ...ok, result: undefined })[0], /results/)
  assert.match(outputProblems({ ...ok, result: { ok: false } })[0], /failed/)
  assert.match(outputProblems({ ...ok, outTime: null })[0], /no output/)
  assert.match(outputProblems({ ...ok, sourceTimes: [11] })[0], /older/)
})

test('the subject and an SMS are text in the picture, never markup', () => {
  assert.ok(pageOf('phone', '<p>x</p>', 'A <b>').includes('A &lt;b&gt;'))
  assert.ok(pageOf('sms', 'a<b', '').includes('a&lt;b'))
})

test('every "previews" entry in notices/ names a real case', () => {
  const dir = new URL('../notices/', import.meta.url).pathname
  for (const c of readdirSync(dir)) previewsOf(JSON.parse(readFileSync(`${dir}${c}/notice.json`, 'utf8')), readdirSync(`${dir}${c}`))
})

const notices = [{ ...odue, files: ['sms.txt.tt'] }]
const data = { koha: '26.05', at: '2026-11-24T10:00:00Z', results: [{ code: 'ODUE', file: 'sms.txt.tt', case: 'no_fine', ok: true }, { code: 'ODUE', file: 'sms.txt.tt', case: 'fine', ok: true }] }

test('TESTED.md says which Koha, when, and the situations', () => {
  assert.deepEqual(reasonsNot(data, notices), [])
  const md = testedMarkdown(data, notices)
  for (const want of ['26.05', '2026-11-24', '2 of 2 checks', '| `ODUE` | SMS | no fine, fine | 2 of 2 |']) assert.ok(md.includes(want), want)
})

test('TESTED.md is refused for a failure, a case or notice that was not run, or an unknown Koha', () => {
  assert.match(reasonsNot({ ...data, results: [{ ...data.results[0], ok: false }, data.results[1]] }, notices)[0], /failed/)
  assert.match(reasonsNot({ ...data, results: [data.results[0]] }, notices)[0], /\(fine\) was not run/)
  assert.match(reasonsNot(data, [...notices, { code: 'HOLD', files: ['sms.txt.tt'] }])[0], /HOLD sms.txt.tt was not run/)
  assert.ok(reasonsNot({ ...data, koha: '' }, notices).length)
  assert.ok(reasonsNot({ ...data, results: [] }, []).length)
})
