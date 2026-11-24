import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EXCLUDED, ZONES, candidates, excludedIn, expected, judge, markdown, merge, parseOutput, probeTemplate, validate } from '../tools/variables.mjs'

const prefs = { dateformat: 'us', symbol: '$', OPACBaseURL: 'https://opac.example.org', LibraryName: 'R' }
const DATE = ' | $KohaDates'
const MARC = ' | $Remove_MARC_punctuation | trim'

test('expected formats dates, money, counts and MARC punctuation by itself', () => {
  assert.equal(expected({ filter: DATE, expr: 'x' }, '2026-12-05 23:59:00', prefs), '12/05/2026')
  assert.equal(expected({ filter: DATE, expr: 'x' }, '2026-12-05', { ...prefs, dateformat: 'metric' }), '05/12/2026')
  assert.equal(expected({ money: true }, '2.500000', prefs), '$2.50')
  assert.equal(expected({ money: true }, null, prefs), '$0.00')
  assert.equal(expected({ number: true }, 0, prefs), '0')
  assert.equal(expected({ filter: MARC, expr: 'item.biblio.title' }, 'A book /', prefs), 'A book')
  assert.equal(expected({ filter: '', expr: 'x' }, null, prefs), '')
})

test('expected knows Koha cleans a tag starting with biblio. a second time', () => {
  assert.equal(expected({ filter: MARC, expr: 'biblio.author' }, 'Smith, J.,', prefs), 'Smith, J')
  assert.equal(expected({ filter: MARC, expr: 'item.biblio.author' }, 'Smith, J.,', prefs), 'Smith, J.')
})

test('the probe template prints a digest item part between exactly two ---- lines, and a loop inside FOREACH', () => {
  assert.equal(probeTemplate(ZONES.CHECKOUT).split('\n').filter((l) => l === '----').length, 2)
  assert.match(probeTemplate(ZONES.ODUE), /\[% FOREACH overdue IN overdues %\]/)
})

test('parseOutput reads zones, the item they belong to and each value', () => {
  const b = parseOutput('@@zone:header@@\n@@v:a.b@@x@@e@@\n@@zone:items@@@@id:B1@@\n@@v:a.b@@y\nz@@e@@@@v:a.b?@@@@e@@')
  assert.deepEqual(b, [{ zone: 'header', id: null, values: { 'a.b': 'x' } }, { zone: 'items', id: 'B1', values: { 'a.b': 'y\nz', 'a.b?': '' } }])
})

// a small notice: one zone with the patron values only
const zone = { zone: 'message', reset: true }
const run = (mode, values, extra = {}) => ({ mode, case: 'c', db: { prefs, patron: { userid: 'u1' }, items: {}, ...extra }, blocks: [{ zone: 'message', id: null, values }] })
const link = 'https://opac.example.org/cgi-bin/koha/opac-password-recovery.pl?uniqueKey=SAMPLE-KEY'

test('judge offers a value that matched, and leaves out one that is empty, wrong or stops Koha, with the reason', () => {
  const good = judge(zone, [run('full', { 'reset.user': 'u1', 'reset.link': link })])
  assert.deepEqual(good.ok.map((v) => v.key), ['reset.user', 'reset.link'])
  for (const [printed, why] of [['', /prints nothing/], ['u2', /something else/], ['@ERR@boom', /error: boom/]])
    assert.match(judge(zone, [run('full', { 'reset.user': printed, 'reset.link': link })]).rejected[0].reason, why)
})

test('judge wants every case to match, not just one', () => {
  const r = judge(zone, [run('full', { 'reset.user': 'u1', 'reset.link': link }), run('full', { 'reset.user': 'zz', 'reset.link': link })])
  assert.equal(r.rejected[0].key, 'reset.user')
})

test('judge checks the "only if present" form: nothing when the value is empty', () => {
  const z = { zone: 'message', hold: 'hold', item: 'item' }
  const v = candidates(z).find((x) => x.key === 'item.public_note')
  assert.equal(v.insert_if_present, '[% IF item.itemnotes %][% item.itemnotes %][% END %]')
  const go = (opt) => judge(z, [
    { mode: 'full', case: '', db: { prefs, items: { B: { itemnotes: 'N' } } }, blocks: [{ zone: 'message', id: 'B', values: { 'item.public_note': 'N', 'item.public_note?': 'N' } }] },
    { mode: 'bare', case: '', db: { prefs, items: { B: { itemnotes: null } } }, blocks: [{ zone: 'message', id: 'B', values: { 'item.public_note': '', 'item.public_note?': opt } }] },
  ])
  assert.ok(go('').ok.some((x) => x.key === 'item.public_note'))
  assert.ok(go('Note: ').rejected.some((x) => x.key === 'item.public_note' && /only if present/.test(x.reason)))
})

test('a money value printed as zero proves nothing', () => {
  const z = { zone: 'items', item: 'item', loan: 'checkout' }
  const go = (fine, printed, opt) => judge(z, [{ mode: 'full', case: '', db: { prefs, items: { A: { checkout: { fine } } } }, blocks: [{ zone: 'items', id: 'A', values: { 'loan.fine': printed, 'loan.fine?': opt } }] }])
  assert.ok(go('0.00', '$0.00', '').rejected.some((x) => x.key === 'loan.fine' && /never printed/.test(x.reason)))
  assert.ok(go('1.25', '$1.25', '$1.25').ok.some((x) => x.key === 'loan.fine'))
})

test('a value printed for the wrong item is caught', () => {
  const z = { zone: 'items', item: 'item' }
  const r = judge(z, [{ mode: 'full', case: '', db: { prefs, items: { A: { barcode: 'A' }, B: { barcode: 'B' } } }, blocks: [{ zone: 'items', id: 'A', values: { 'item.barcode': 'A' } }, { zone: 'items', id: 'B', values: { 'item.barcode': 'A' } }] }])
  assert.ok(r.rejected.some((x) => x.key === 'item.barcode'))
})

test('record text carries the punctuation filter, and every date the date filter', () => {
  for (const zones of Object.values(ZONES)) for (const z of zones) for (const v of candidates(z)) {
    if (/^record\.(title|subtitle|author|series|part_|publisher|edition|pages|place)/.test(v.key)) assert.match(v.insert, /Remove_MARC_punctuation \| trim/, v.key)
    if (/date/.test(v.expr) && v.key !== 'record.year') assert.match(v.insert, /KohaDates/, v.key)
  }
})

test('merge joins the same value valid in two places', () => {
  assert.deepEqual(merge([{ key: 'a.b', insert: 'x', zone: 'header' }, { key: 'a.b', insert: 'x', zone: 'footer' }]), [{ key: 'a.b', insert: 'x', valid_in: ['header', 'footer'] }])
})

test('no candidate of any notice is on the exclusion list, and every excluded field is recognised', () => {
  for (const [code, zones] of Object.entries(ZONES))
    for (const z of zones) for (const v of candidates(z)) assert.equal(excludedIn(v.insert), undefined, `${code} ${v.key}`)
  for (const k of Object.keys(EXCLUDED)) assert.equal(excludedIn(`[% ${k.includes('.') ? k : `${k}.firstname`} %]`), k)
  assert.equal(excludedIn('[% overdue.item.itemnotes_nonpublic %]'), 'item.itemnotes_nonpublic')
  assert.equal(excludedIn('[% hold.borrower.password %]'), 'borrower.password')
})

test('validate finds a missing IF form, an unknown place, an excluded value and a rejection without a reason', () => {
  const v = { key: 'a.b', label: 'L', insert: '[% x %]', filter: null, may_be_empty: false, insert_if_present: null, cases: [''], valid_in: ['message'] }
  const data = (over, rejected = []) => ({ koha: '26.05', notices: { X: { zones: ['message'], note: '', variables: [{ ...v, ...over }], rejected } } })
  assert.deepEqual(validate(data({})), [])
  assert.match(validate(data({ may_be_empty: true }))[0], /no IF form/)
  assert.match(validate(data({ valid_in: ['footer'] }))[0], /unknown zone/)
  assert.match(validate(data({ insert: '[% borrower.borrowernotes %]' }))[0], /never be offered/)
  assert.match(validate(data({}, [{ key: 'q' }]))[0], /without a reason/)
})

test('variables.json is valid, and VARIABLES.md is generated from it', () => {
  const root = new URL('..', import.meta.url).pathname
  const data = JSON.parse(readFileSync(`${root}variables.json`, 'utf8'))
  assert.deepEqual(validate(data), [])
  assert.equal(markdown(data), readFileSync(`${root}VARIABLES.md`, 'utf8'))
  assert.deepEqual(data.excluded, EXCLUDED)
})
