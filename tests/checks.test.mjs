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

// ── notices with several situations (overdue: no fine, a fine, a restricted account) ──
const overdue = {
  code: 'ODUE', digest: false, scenario: 'overdue1', expect: ['KNT-ITEM-1', '{DUE}'], expect_sms: ['{DUE}'], absent: ['KNT-ITEM-3'],
  cases: [
    { name: 'no-fine', scenario: 'overdue1', absent: ['Fine so far'] },
    { name: 'fine', scenario: 'overdue1:fine', expect: ['Fine so far $2.50'], counts: { 'Fine so far': 1 } },
  ],
}

test('casesOf runs a notice once per situation, adding to the notice’s own expectations; the first keeps the plain name', () => {
  const [a, b] = casesOf(overdue)
  assert.deepEqual([a.case, b.case], [null, 'fine'])
  assert.equal(b.scenario, 'overdue1:fine')
  assert.deepEqual(b.expect, ['KNT-ITEM-1', '{DUE}', 'Fine so far $2.50'])
  assert.deepEqual(a.absent, ['KNT-ITEM-3', 'Fine so far'])
  assert.deepEqual(casesOf(notice).map((n) => n.expect), [notice.expect])
})

test('a fines line fails without a fine, and its absence or repetition fails with one', () => {
  const [none, fine] = casesOf(overdue)
  const body = (f) => `KNT-ITEM-1 was due 11/16/2026${f}
`
  const run = (n, f) => checkOutput(n, 'email.txt.tt', { content: body(f), subject: '', due: '11/16/2026' })
  assert.deepEqual(run(none, ''), [])
  assert.deepEqual(run(fine, ' Fine so far $2.50'), [])
  assert.ok(run(none, ' Fine so far $0.00').some((x) => x.includes('must not be in the output')))
  assert.ok(run(fine, '').some((x) => x.includes('Fine so far $2.50')))
  assert.ok(run(fine, ' Fine so far $2.50 Fine so far $0.00').some((x) => x.includes('appears 2 times')))
})

test('an SMS must carry the due date, and an item that is not due must not appear', () => {
  const [n] = casesOf(overdue)
  assert.ok(checkOutput(n, 'sms.txt.tt', { content: 'Lib: overdue', subject: '', due: '11/16/2026' }).some((x) => x.includes('in the SMS')))
  assert.ok(checkOutput(n, 'sms.txt.tt', { content: 'due 11/16/2026 KNT-ITEM-3', subject: '', due: '11/16/2026' }).some((x) => x.includes('KNT-ITEM-3')))
})
