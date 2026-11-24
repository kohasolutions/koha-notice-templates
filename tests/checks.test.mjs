// Unit tests for the checks in tools/render.mjs and tools/lint.mjs: they run in CI without a Koha.
// The live proof is tools/render.mjs against a real Koha.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markValues, unmark, checkOutput, casesOf } from '../tools/render.mjs'
import { problemsOf } from '../tools/lint.mjs'

const OPEN = '⁠⁣'
const CLOSE = '⁣⁠'

test('markValues wraps printed values and leaves directives, comments and the branding block alone', () => {
  const tt = '[%- a = 1; b = 2 -%][%# note %][% IF x %][% borrower.firstname %][% END %][% checkout.date_due | $KohaDates %]'
  const out = markValues(tt)
  assert.equal(out.split(OPEN).length - 1, 2)
  assert.ok(out.includes(`${OPEN}[% borrower.firstname %]${CLOSE}`))
  assert.ok(out.includes('[%- a = 1; b = 2 -%]'))
  assert.ok(out.includes('[% IF x %]') && out.includes('[% END %]') && out.includes('[%# note %]'))
  assert.equal(unmark(out), tt)
})

const notice = { code: 'CHECKOUT', digest: true, expect: ['KNT-ITEM-1', 'KNT-ITEM-2'] }
const good = 'Dear Jane,\n\n* A\n  KNT-ITEM-1\n\n* B\n  KNT-ITEM-2\n\nRiverside Library\n'

test('checkOutput passes a correct digest', () => {
  assert.deepEqual(checkOutput(notice, 'email.txt.tt', { content: good, subject: 'Items' }), [])
})

test('checkOutput reports a value that printed empty, in the content and in the subject', () => {
  const p = checkOutput(notice, 'email.txt.tt', { content: good + `Due ${OPEN}${CLOSE}`, subject: `From ${OPEN}${CLOSE}` })
  assert.ok(p.some((x) => x.includes('empty in the content')))
  assert.ok(p.some((x) => x.includes('empty in the subject')))
})

test('checkOutput reports a left-over tag, a missing item and a repeated greeting', () => {
  const p = checkOutput(notice, 'email.txt.tt', { content: 'Dear Jane,\nDear Jane,\nKNT-ITEM-1 [% x', subject: '' })
  assert.ok(p.some((x) => x.includes('Template Toolkit tag')))
  assert.ok(p.some((x) => x.includes('KNT-ITEM-2')))
  assert.ok(p.some((x) => x.includes('greeting appears 2 times')))
})

test('checkOutput counts SMS lines instead of barcodes, and caps the length', () => {
  assert.deepEqual(checkOutput(notice, 'sms.txt.tt', { content: 'Lib: you borrowed\n- A\n- B\n', subject: '' }), [])
  const p = checkOutput(notice, 'sms.txt.tt', { content: 'Lib\n- A\n' + 'x'.repeat(400), subject: '' })
  assert.ok(p.some((x) => x.includes('lists 1 items')))
  assert.ok(p.some((x) => x.includes('characters')))
})

const BLOCK = '[%-\n  # ── Your library: change the value on this line only. ──\n  library_name = branch.branchname;\n-%]\n'
const meta = { code: 'CHECKOUT', module: 'circulation', name: 'n', menu: 'm', subject: 's', scenario: 'checkout', digest: true, about: 'a' }

test('lint accepts a correct digest notice', () => {
  assert.deepEqual(problemsOf('CHECKOUT', meta, { 'sms.txt.tt': BLOCK + 'head\n----\nrow\n----\n' }), [])
})

test('lint catches a missing separator, no branding block, an outside image, a stylesheet and <html>', () => {
  const p = problemsOf('CHECKOUT', meta, {
    'email.html.tt': 'head\n----\nrow\n<img src="https://tracker.example.com/p.gif"><link rel="stylesheet"><html>',
  })
  for (const want of ['exactly two ---- lines', '"Your library" block', 'tracker.example.com', 'stylesheet', '<html>'])
    assert.ok(p.some((x) => x.includes(want)), want)
})

test('lint catches a ---- in a notice that is not a digest, and a folder/code mismatch', () => {
  const p = problemsOf('ISSUESLIP', { ...meta, code: 'ISSUESLIP', digest: false }, { 'print.html.tt': BLOCK + 'a\n----\n' })
  assert.ok(p.some((x) => x.includes('digest separator')))
  assert.ok(problemsOf('ISSUESLIP', meta, { 'print.html.tt': BLOCK }).some((x) => x.includes('folder is "ISSUESLIP"')))
})

test("lint allows the library's own logo_url", () => {
  const files = { 'email.html.tt': BLOCK + 'h\n----\n<img src="[% logo_url %]">\n----\n' }
  assert.deepEqual(problemsOf('CHECKOUT', meta, files), [])
})

const sometimes = { code: 'X', digest: false, expect: ['A'], expectByFile: { 'sms.txt.tt': ['Lib'] } }
const kase = { name: 'renewed', subject: 'Renewed: ', expect: ['It is now due'], reject: ['could not renew'] }

test('a notice without cases has one; a notice with cases keeps them', () => {
  assert.deepEqual(casesOf({}), [{ name: '' }])
  assert.deepEqual(casesOf({ cases: [kase] }), [kase])
})

test('checkOutput checks a case: its text, the text of another case, its subject and what Koha says must be there', () => {
  const good = { content: 'A. It is now due on 1 May', subject: 'Renewed: Book', must: ['1 May'] }
  assert.deepEqual(checkOutput(sometimes, 'email.txt.tt', good, kase), [])
  const p = checkOutput(sometimes, 'email.txt.tt', { content: 'A. Could not renew', subject: 'Not renewed: Book', must: ['1 May'] }, kase)
  for (const want of ['expected "It is now due"', 'expected "1 May"', 'does not belong', 'subject should start'])
    assert.ok(p.some((x) => x.includes(want)), want)
})

test('checkOutput reads expectByFile for that file only', () => {
  assert.ok(checkOutput(sometimes, 'sms.txt.tt', { content: 'x', subject: '' }).some((x) => x.includes('"Lib"')))
  assert.deepEqual(checkOutput(sometimes, 'email.txt.tt', { content: 'A', subject: '' }), [])
})

test('lint catches a subject Koha would not store, and cases with no name or the same name', () => {
  const files = { 'email.txt.tt': BLOCK + 'x' }
  const m = { ...meta, digest: false }
  assert.deepEqual(problemsOf('CHECKOUT', { ...m, cases: [kase] }, files), [])
  assert.ok(problemsOf('CHECKOUT', { ...m, subject: 'x'.repeat(191) }, files).some((x) => x.includes('Koha keeps 200')))
  assert.ok(problemsOf('CHECKOUT', { ...m, cases: [kase, kase] }, files).some((x) => x.includes('same name')))
  assert.ok(problemsOf('CHECKOUT', { ...m, cases: [{}] }, files).some((x) => x.includes('lower-case name')))
})
