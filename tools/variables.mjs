#!/usr/bin/env node
// Which Koha values a librarian can put in each notice, proved through a real Koha.
//
//   node tools/variables.mjs           probe Koha, write variables.json and VARIABLES.md
//   node tools/variables.mjs --check   no Koha: variables.json is valid and VARIABLES.md is generated from it (CI)
//
// Each value is a CANDIDATE until Koha prints it. For every notice and every case a template is generated that prints
// all candidates between markers; Koha makes the real event happen (tools/koha-render.pl, rolled back) and what it
// printed is compared with the database, formatted here without Koha's filters. Twice: with every optional value
// filled, and with all of them empty, where the "only if present" form must print nothing. A candidate that fails
// anywhere is left out and listed with the reason.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { casesOf, loadNotices, runKoha } from './render.mjs'

const ROOT = new URL('..', import.meta.url).pathname

/** Never offered: secrets, staff notes, other people, and personal data a message has no reason to repeat. */
export const EXCLUDED = {
  'borrower.password': 'secret', 'borrower.secret': 'secret', 'borrower.overdrive_auth_token': 'secret', 'borrower.auth_method': 'security setting',
  'borrower.flags': 'staff permissions', 'borrower.login_attempts': 'security setting', 'borrower.borrowernotes': 'staff note',
  'borrower.debarredcomment': 'staff comment on a restriction', 'borrower.contactnote': 'staff note', 'borrower.sort1': 'staff statistics field',
  'borrower.sort2': 'staff statistics field', 'borrower.dateofbirth': 'personal data', 'borrower.sex': 'personal data',
  'borrower.contactname': 'another person', 'borrower.altcontactsurname': 'another person', 'borrower.relationship': 'another person',
  'branch.branchnotes': 'staff note', 'branch.branchip': 'network detail', 'item.itemnotes_nonpublic': 'staff note', 'item.price': 'purchase price',
  'item.booksellerid': 'purchase detail', 'item.stack': 'staff field', 'checkout.issuer_id': 'staff member', 'checkout.note': "patron's note to staff",
  'hold.reservenotes': 'note that staff may write', 'librarian': 'staff member',
}

const MARC = ' | $Remove_MARC_punctuation | trim'
const DATE = ' | $KohaDates'
const PRICE = ' | $Price with_symbol => 1'

// [key, what it is, expression after the prefix, where its value is in the database, options]
const PATRON = [
  ['title', 'Patron title (Ms, Dr…)', 'title', 'title', { empty: true }],
  ['firstname', 'Patron first name', 'firstname', 'firstname', { empty: true, always_here: true }],
  ['middle_name', 'Patron middle name', 'middle_name', 'middle_name', { empty: true }],
  ['preferred_name', 'Patron preferred name', 'preferred_name', 'preferred_name', { empty: true }],
  ['surname', 'Patron surname', 'surname', 'surname'],
  ['othernames', 'Patron other names', 'othernames', 'othernames', { empty: true }],
  ['cardnumber', 'Card number', 'cardnumber', 'cardnumber', { empty: true, always_here: true }],
  ['userid', 'User name', 'userid', 'userid', { empty: true, always_here: true }],
  ['category', 'Patron category', 'category.description', 'category'],
  ['home_library', "Patron's home library", 'library.branchname', 'home_library'],
  ['dateexpiry', 'Membership ends on', 'dateexpiry', 'dateexpiry', { filter: DATE, empty: true, always_here: true }],
  ['dateenrolled', 'Member since', 'dateenrolled', 'dateenrolled', { filter: DATE, empty: true, always_here: true }],
  ['email', 'Patron email address', 'email', 'email', { empty: true, always_here: true }],
  ['phone', 'Patron phone', 'phone', 'phone', { empty: true }],
  ['mobile', 'Patron other phone', 'mobile', 'mobile', { empty: true }],
  ['address', 'Patron address', 'address', 'address', { empty: true }],
  ['address2', 'Patron address, second line', 'address2', 'address2', { empty: true }],
  ['city', 'Patron city', 'city', 'city', { empty: true }],
  ['state', 'Patron state', 'state', 'state', { empty: true }],
  ['zipcode', 'Patron postal code', 'zipcode', 'zipcode', { empty: true }],
  ['country', 'Patron country', 'country', 'country', { empty: true }],
  ['opacnote', 'OPAC note on the patron', 'opacnote', 'opacnote', { empty: true }],
  ['checkouts_count', 'Number of items on loan', 'checkouts.count', 'checkouts', { number: true }],
  ['overdues_count', 'Number of overdue items', 'overdues.count', 'overdues', { number: true }],
  ['holds_count', 'Number of holds', 'holds.count', 'holds', { number: true }],
  ['balance', 'Balance owed on the account', 'account.balance', 'balance', { filter: PRICE, money: true }],
].map((v) => [...v.slice(0, 4), v[4] ?? {}])

const LIBRARY = [
  ['name', 'Library name', 'branchname'], ['address1', 'Library address', 'branchaddress1', 1], ['address2', 'Library address, second line', 'branchaddress2', 1],
  ['address3', 'Library address, third line', 'branchaddress3', 1], ['city', 'Library city', 'branchcity', 1], ['state', 'Library state', 'branchstate', 1],
  ['zip', 'Library postal code', 'branchzip', 1], ['country', 'Library country', 'branchcountry', 1], ['phone', 'Library phone', 'branchphone', 1],
  ['fax', 'Library fax', 'branchfax', 1], ['email', 'Library email', 'branchemail', 1], ['url', 'Library website', 'branchurl', 1],
].map(([k, label, col, empty]) => [k, label, col, col, { empty: !!empty }])

const ITEM = [
  ['barcode', 'Barcode', 'barcode', 'barcode'],
  ['callnumber', 'Call number', 'itemcallnumber', 'itemcallnumber', { empty: true }],
  ['public_note', 'Public note on the item', 'itemnotes', 'itemnotes', { empty: true }],
  ['enumchron', 'Volume or issue', 'enumchron', 'enumchron', { empty: true }],
  ['copynumber', 'Copy number', 'copynumber', 'copynumber', { empty: true }],
  ['materials', 'Materials specified (parts, maps…)', 'materials', 'materials', { empty: true }],
]
const BIBLIO = [
  ['title', 'Title', 'title', 'title', { filter: MARC }],
  ['subtitle', 'Subtitle', 'subtitle', 'subtitle', { filter: MARC, empty: true }],
  ['author', 'Author', 'author', 'author', { filter: MARC, empty: true }],
  ['part_number', 'Part number', 'part_number', 'part_number', { filter: MARC, empty: true }],
  ['part_name', 'Part name', 'part_name', 'part_name', { filter: MARC, empty: true }],
  ['series', 'Series', 'seriestitle', 'seriestitle', { filter: MARC, empty: true }],
  ['year', 'Year', 'copyrightdate', 'copyrightdate', { empty: true }],
]
const BIBLIOITEM = [
  ['isbn', 'ISBN', 'isbn', 'isbn', { empty: true }],
  ['issn', 'ISSN', 'issn', 'issn', { empty: true }],
  ['publisher', 'Publisher', 'publishercode', 'publishercode', { filter: MARC, empty: true }],
  ['publication_year', 'Publication year', 'publicationyear', 'publicationyear', { empty: true }],
  ['edition', 'Edition', 'editionstatement', 'editionstatement', { filter: MARC, empty: true }],
  ['pages', 'Pages', 'pages', 'pages', { filter: MARC, empty: true }],
  ['place', 'Place of publication', 'place', 'place', { filter: MARC, empty: true }],
]
const LOAN = [
  ['due', 'Due date', 'date_due', 'date_due', { filter: DATE }],
  ['borrowed', 'Borrowed on', 'issuedate', 'issuedate', { filter: DATE }],
  ['renewals', 'Times renewed', 'renewals_count', 'renewals_count', { number: true }],
  ['loan_library', 'Library where it was borrowed', 'library.branchname', 'library'],
  ['fine', 'Fine so far on this item', 'overdue_fines.total_outstanding', 'fine', { filter: PRICE, money: true }],
]
const OLD_LOAN = [['returned', 'Returned on', 'returndate', 'returndate', { filter: DATE }], ...LOAN.filter((v) => ['due', 'borrowed', 'renewals', 'loan_library'].includes(v[0]))]
const HOLD = [
  ['reserved', 'Reserved on', 'reservedate', 'reservedate', { filter: DATE }],
  ['waiting', 'Waiting since', 'waitingdate', 'waitingdate', { filter: DATE, empty: true, always_here: true }],
  ['collect_by', 'Collect by', 'expirationdate', 'expirationdate', { filter: DATE, empty: true, always_here: true }],
  ['pickup_library', 'Pickup library', 'branch.branchname', 'branchname'],
  ['pickup_address', 'Pickup library address', 'branch.branchaddress1', 'branchaddress1', { empty: true }],
  ['pickup_city', 'Pickup library city', 'branch.branchcity', 'branchcity', { empty: true }],
  ['pickup_phone', 'Pickup library phone', 'branch.branchphone', 'branchphone', { empty: true }],
]

/** One zone = one place in the template. `hash`: Koha passes plain rows there, so methods do not work. */
const single = (o) => [{ zone: 'message', globals: true, ...o }]
const sections = (o) => [{ zone: 'header', globals: true }, { zone: 'items', globals: true, separated: true, ...o }, { zone: 'footer', globals: true }]
const loop = (list, name, o) => ({ zone: 'items', loop: [name, list], ...o })
const viaLoan = (v) => ({ item: `${v}.item`, biblio: `${v}.item.biblio`, biblioitem: `${v}.item.biblioitem`, loan: v })
const plain = { item: 'item', biblio: 'biblio', biblioitem: 'biblioitem' }
const overdues = [{ zone: 'message', globals: true }, loop('overdues', 'overdue', { globals: true, ...viaLoan('overdue') })]
const digestHash = [{ zone: 'message', globals: true }, loop('checkouts', 'checkout', { globals: true, hash: true, item: 'checkout', biblio: 'checkout', biblioitem: 'checkout', loan: 'checkout' })]
export const ZONES = {
  CHECKOUT: sections({ ...plain, biblio: 'item.biblio', loan: 'checkout' }),
  CHECKIN: sections({ ...plain, biblio: 'item.biblio', old: 'old_checkout' }),
  ISSUESLIP: [{ zone: 'message', globals: true }, { ...loop('checkouts', 'checkout', { globals: true, ...viaLoan('checkout') }), zone: 'items on loan' }, { ...loop('overdues', 'overdue', { globals: true, ...viaLoan('overdue') }), zone: 'overdue items' }],
  PREDUE: single({ ...plain, loan: 'checkout', loanHash: true }),
  DUE: single({ ...plain, loan: 'checkout', loanHash: true }),
  PREDUEDGST: digestHash, DUEDGST: digestHash,
  ODUE: overdues, ODUE2: overdues, ODUE3: overdues,
  HOLD: single({ ...plain, hold: 'hold' }),
  HOLDDGST: sections({ ...plain, biblio: 'hold.biblio', hold: 'hold' }),
  HOLD_REMINDER: [{ zone: 'message', globals: true }, loop('holds', 'hold', { globals: true, item: 'hold.item', biblio: 'hold.biblio', biblioitem: 'hold.biblio.biblioitem', hold: 'hold' })],
  AUTO_RENEWALS: single({ ...plain, biblioitem: 'item.biblioitem', loan: 'checkout' }),
  AUTO_RENEWALS_DGST: [{ zone: 'message', globals: true, digestCounts: true }, loop('checkouts', 'checkout', { globals: true, ...viaLoan('checkout') })],
  WELCOME: single({}), MEMBERSHIP_EXPIRY: single({}),
  PASSWORD_RESET: single({ reset: true }),
}

/** Every candidate of one zone: { key, label, expr, filter, cond, db(d, item) -> raw value, … } */
export function candidates(z) {
  const out = []
  const add = (group, prefix, list, row) => {
    for (const [key, label, path, col, o = {}] of list)
      out.push({ key: `${group}.${key}`, label, expr: `${prefix}.${path}`, filter: o.filter ?? '', ...o, db: (d, it) => row(d, it)?.[col] })
  }
  if (z.globals) {
    add('patron', 'borrower', PATRON, (d) => d.patron)
    // a digest section belongs to its own hold's library; the rest is the sample library
    add('library', 'branch', LIBRARY, (d, it) => (z.hold && it ? Object.values(d.libraries).find((l) => l.branchname === it.hold?.branchname) : d.libraries.KNTLIB))
    const opac = "Koha.Preference('OPACBaseURL')"
    const link = (key, label, path) =>
      out.push({ key, label, expr: opac, tail: path, cond: opac, empty: true, filter: '', db: (d) => (d.prefs.OPACBaseURL ? d.prefs.OPACBaseURL + path : '') })
    link('link.catalogue', 'Address of the online catalogue', '')
    link('link.account', 'Address of the patron account', '/cgi-bin/koha/opac-user.pl')
    out.push({ key: 'system.library_name', label: 'Library name in the system preference LibraryName', expr: "Koha.Preference('LibraryName')", filter: '', empty: true, db: (d) => d.prefs.LibraryName })
    out.push({ key: 'system.today', label: "Today's date", expr: 'today', filter: DATE, db: (d) => d.today })
  }
  const item = (d, it) => it
  if (z.item) {
    add('item', z.item, ITEM, item)
    const code = (key, label, expr, cond, col, o = {}) => out.push({ key: `item.${key}`, label, expr, cond, filter: '', ...o, db: (d, it) => it?.[col] })
    code('type', 'Item type', `ItemTypes.GetDescription(${z.item}.${z.hash ? 'itype' : 'effective_itemtype'})`, null, 'itemtype')
    code('home_library', 'Home library of the item', `Branches.GetName(${z.item}.homebranch)`, null, 'home')
    const av = (f) => `AuthorisedValues.GetDescriptionByKohaField({ kohafield => 'items.${f}', authorised_value => ${z.item}.${f}, opac => 1 })`
    code('location', 'Shelving location', av('location'), `${z.item}.location`, 'location_text', { empty: true })
    code('collection', 'Collection', av('ccode'), `${z.item}.ccode`, 'ccode_text', { empty: true })
    out.push({ key: 'link.record', label: 'Address of the record in the catalogue', expr: "Koha.Preference('OPACBaseURL')", cond: "Koha.Preference('OPACBaseURL')", filter: '', empty: true,
      tail: `/cgi-bin/koha/opac-detail.pl?biblionumber=[% ${z.item}.biblionumber %]`,
      db: (d, it) => (d.prefs.OPACBaseURL ? `${d.prefs.OPACBaseURL}/cgi-bin/koha/opac-detail.pl?biblionumber=${it?.biblionumber}` : '') })
  }
  if (z.biblio) add('record', z.biblio, BIBLIO, (d, it) => it?.biblio)
  if (z.biblioitem) add('record', z.biblioitem, BIBLIOITEM, (d, it) => it?.biblioitem)
  if (z.loan) add('loan', z.loan, LOAN, (d, it) => it?.checkout)
  if (z.old) add('loan', z.old, OLD_LOAN, (d, it) => it?.old_checkout)
  if (z.hold) add('hold', z.hold, HOLD, (d, it) => it?.hold)
  if (z.digestCounts)
    for (const [k, l] of [['success', 'Number of items renewed'], ['error', 'Number of items not renewed']])
      out.push({ key: `renewal.${k}`, label: l, expr: k, filter: '', number: true, fromCase: k })
  if (z.reset) {
    out.push({ key: 'reset.user', label: 'User name', expr: 'user', filter: '', db: (d) => d.patron.userid })
    out.push({ key: 'reset.link', label: 'Link to set a new password', expr: 'passwordreseturl', filter: '', db: (d) => `${d.prefs.OPACBaseURL}/cgi-bin/koha/opac-password-recovery.pl?uniqueKey=SAMPLE-KEY` })
  }
  for (const v of out) {
    v.insert = `[% ${v.expr}${v.filter} %]${v.tail ?? ''}`
    v.insert_if_present = v.empty || v.money ? `[% IF ${v.cond ?? v.expr}${v.money ? ' > 0' : ''} %]${v.insert}[% END %]` : null
  }
  return out
}

// success/error of each AUTO_RENEWALS_DGST case, from the plan in koha-render.pl (too-soon loans count in neither)
const DIGEST_COUNTS = { renewed: [3, 0], last_renewal: [1, 0], not_renewed: [0, 3], mixed: [1, 1] }

export const PLUGINS = ['Koha', 'Price', 'ItemTypes', 'Branches', 'AuthorisedValues']
const USES = `[%- ${PLUGINS.map((p) => `USE ${p}`).join('; ')}; -%]\n`

/** The probe template of a notice: every candidate, in every zone, between markers; errors are caught one by one. */
export function probeTemplate(zones) {
  let t = USES
  for (const z of zones) {
    let body = `@@zone:${z.zone}@@` + (z.item ? `@@id:[% ${z.item}.barcode %]@@` : '') + '\n'
    for (const v of candidates(z)) {
      body += `@@v:${v.key}@@[% TRY %]${v.insert}[% CATCH %]@ERR@[% error.info %][% END %]@@e@@\n`
      if (v.insert_if_present) body += `@@v:${v.key}?@@[% TRY %]${v.insert_if_present}[% CATCH %]@ERR@[% error.info %][% END %]@@e@@\n`
    }
    if (z.loop) body = `[% FOREACH ${z.loop[0]} IN ${z.loop[1]} %]${body}[% END %]`
    t += z.separated ? `----\n${body}----\n` : body
  }
  return t
}

/** [{ zone, id, values: { key: printed } }] in the order printed. */
export function parseOutput(text) {
  const blocks = []
  for (const part of text.split('@@zone:').slice(1)) {
    const zone = part.slice(0, part.indexOf('@@'))
    const id = /@@id:(.*?)@@/.exec(part)?.[1] ?? null
    const values = {}
    for (const m of part.matchAll(/@@v:(.+?)@@([\s\S]*?)@@e@@/g)) values[m[1]] = m[2]
    blocks.push({ zone, id, values })
  }
  return blocks
}

const strip = (s) => s.replace(/\p{P}$/u, '')
/** What a patron should read for a database value: written here again, not taken from Koha's own filters. */
export function expected(v, raw, prefs) {
  if (raw === null || raw === undefined || raw === '') return v.number ? '0' : v.money ? `${prefs.symbol}0.00` : ''
  if (v.money) return `${prefs.symbol}${Number(raw).toFixed(2)}`
  if (v.number) return String(Number(raw))
  if (v.filter === DATE) {
    const [y, m, d] = String(raw).slice(0, 10).split('-')
    return { us: `${m}/${d}/${y}`, metric: `${d}/${m}/${y}`, iso: `${y}-${m}-${d}`, dmydot: `${d}.${m}.${y}` }[prefs.dateformat]
  }
  let s = String(raw)
  if (v.filter === MARC) s = strip(s).trim()
  // Koha adds its own clean-up to a tag that starts with biblio. or biblioitem. (C4/Letters.pm add_tt_filters)
  if (/^biblio(item)?\./.test(v.expr)) s = strip(s)
  return s
}

/** Judge one zone of one notice over all its runs. runs: [{ mode, case, db, blocks, error }] */
export function judge(z, runs) {
  const ok = []
  const rejected = []
  for (const v of candidates(z)) {
    let reason = null
    let seen = false
    const cases = new Set()
    for (const run of runs) {
      for (const b of run.blocks.filter((x) => x.zone === z.zone)) {
        const it = b.id ? run.db.items[b.id] : z.item ? null : undefined
        if (z.item && !it) reason ??= 'the item it belongs to could not be identified'
        const got = b.values[v.key]
        const raw = v.fromCase ? DIGEST_COUNTS[run.case]?.[v.fromCase === 'success' ? 0 : 1] : v.db(run.db, it)
        const want = expected(v, raw, run.db.prefs)
        const where = `${run.mode === 'bare' ? 'empty values, ' : ''}${run.case || 'the only case'}`
        if (got === undefined) reason ??= `not printed (${where})`
        else if (got.startsWith('@ERR@')) reason ??= `Koha stops with an error: ${got.slice(5).split('\n')[0].replace(/ at \/.*$/, '').slice(0, 120)}`
        else if (got !== want && !(run.mode === 'bare' && v.tail)) reason ??= got === '' ? `prints nothing (${where})` : `prints something else than the database holds (${where})`
        else if (run.mode === 'full' && got !== '' && (!v.money || Number(raw) > 0)) { // a zero proves nothing: Koha prints it for an unknown name too
          seen = true
          cases.add(run.case || '')
        }
        const opt = b.values[`${v.key}?`]
        if (v.insert_if_present && !reason) {
          const wantOpt = v.money ? (Number(raw ?? 0) > 0 ? want : '') : want
          if (opt !== wantOpt) reason = `the "only if present" form prints the wrong thing (${where})`
        }
        if (!v.empty && !v.money && run.mode === 'bare' && got === '' && !reason && !v.reset) reason = `is empty when optional values are (${where})`
      }
    }
    if (!reason && !seen) reason = 'was never printed with a value'
    if (reason) rejected.push({ key: v.key, label: v.label, zone: z.zone, expression: v.expr, reason })
    else
      ok.push({ key: v.key, label: v.label, zone: z.zone, insert: v.insert, filter: v.filter ? v.filter.replace(/^ \| /, '') : null,
        may_be_empty: !!v.empty, insert_if_present: v.insert_if_present, cases: [...cases].sort() })
  }
  return { ok, rejected }
}

export function merge(list) {
  const out = []
  for (const v of list) {
    const same = out.find((o) => o.key === v.key && o.insert === v.insert)
    if (same) same.valid_in.push(v.zone)
    else {
      const { zone, ...rest } = v
      out.push({ ...rest, valid_in: [zone] })
    }
  }
  return out
}

export function validate(data) {
  const p = []
  if (!/^\d+\.\d+/.test(data.koha ?? '')) p.push('no Koha release')
  for (const [code, n] of Object.entries(data.notices ?? {})) {
    const zones = new Set(n.zones)
    for (const v of n.variables) {
      const at = `${code} ${v.key}`
      for (const k of ['key', 'label', 'insert']) if (typeof v[k] !== 'string' || !v[k]) p.push(`${at}: no ${k}`)
      if (typeof v.may_be_empty !== 'boolean') p.push(`${at}: may_be_empty is not true or false`)
      if (v.may_be_empty && !/^\[% IF .+ %\].+\[% END %\]$/.test(v.insert_if_present ?? '')) p.push(`${at}: may be empty but has no IF form`)
      if (!v.valid_in?.length || v.valid_in.some((z) => !zones.has(z))) p.push(`${at}: valid_in is empty or names an unknown zone`)
      if (!v.cases?.length) p.push(`${at}: proved in no case`)
      const hit = excludedIn(v.insert)
      if (hit) p.push(`${at}: ${hit} must never be offered (${EXCLUDED[hit]})`)
    }
    for (const r of n.rejected) if (!r.reason) p.push(`${code} ${r.key}: rejected without a reason`)
  }
  return p
}

/** The excluded value a template text prints, if any: by field name, whatever object it hangs on. */
export function excludedIn(tt) {
  const words = new Set([...tt.matchAll(/\[%([\s\S]*?)%\]/g)].flatMap((m) => m[1].match(/[A-Za-z_][\w]*/g) ?? []))
  const owner = { item: /\b(item|checkout|overdue)\b/, checkout: /\b(checkout|overdue)\b/, hold: /\bhold\b/, borrower: /./, branch: /./ }
  return Object.keys(EXCLUDED).find((k) => {
    const [obj, field] = k.split('.')
    return field ? words.has(field) && owner[obj].test(tt) : words.has(obj)
  })
}

const cell = (s) => String(s).replace(/\|/g, '\\|')
export function markdown(data) {
  const L = ['# Values you can put in each notice', '',
    `<!-- generated by tools/variables.mjs from variables.json: do not edit -->`, '',
    `Every value below was printed by a real Koha ${data.koha} in that notice and compared with the database, in every`,
    'situation the notice is tested in, with optional values filled and with them empty. A value that failed is not offered.',
    'Copy the code as it is: the date, price and punctuation filters are part of it. Where a value can be empty, use the',
    '"only if present" form. `USE` lines a value needs are listed at the end.', '']
  for (const [code, n] of Object.entries(data.notices)) {
    L.push(`## ${code}`, '', n.note ? `${n.note}\n` : '', '| Value | Code | Only if present | Where |', '|---|---|---|---|')
    for (const v of n.variables)
      L.push(`| ${cell(v.label)} | \`${cell(v.insert)}\` | ${v.insert_if_present ? `\`${cell(v.insert_if_present)}\`` : 'always there'} | ${v.valid_in.join(', ')} |`)
    L.push('')
    if (n.rejected.length) {
      L.push('<details><summary>Tried and left out</summary>', '', '| Value | Expression | Where | Why |', '|---|---|---|---|')
      for (const r of n.rejected) L.push(`| ${cell(r.label)} | \`${cell(r.expression)}\` | ${r.valid_in.join(', ')} | ${cell(r.reason)} |`)
      L.push('', '</details>', '')
    }
  }
  L.push('## USE lines', '', 'Put these in the top block when you use such a value: `Koha` (links, LibraryName), `Price` (money), `ItemTypes` (item type),',
    '`Branches` (home library of the item), `AuthorisedValues` (shelving location, collection), each as `USE Name;`.', '',
    '## Never offered', '', '| Field | Why |', '|---|---|', ...Object.entries(data.excluded).map(([k, why]) => `| \`${k}\` | ${why} |`), '')
  return L.filter((x, i) => !(x === '' && L[i - 1] === '')).join('\n')
}

const NOTES = {
  PREDUE: 'Koha passes the loan as a plain row here: `checkout.date_due` works, anything that needs a method on the loan does not.',
  DUE: 'Koha passes the loan as a plain row here: `checkout.date_due` works, anything that needs a method on the loan does not.',
  PREDUEDGST: 'Each loan is one plain row of the loan, the item and the record together: only their own columns, no methods.',
  DUEDGST: 'Each loan is one plain row of the loan, the item and the record together: only their own columns, no methods.',
  HOLDDGST: 'The header and footer come from the last hold added; in the items part `branch` is that hold’s pickup library.',
  PASSWORD_RESET: 'Koha tells this notice neither the patron nor the library: only the values below.',
  CHECKOUT: 'Values of an item belong between the two `----` lines.',
  CHECKIN: 'Values of an item belong between the two `----` lines.',
}

async function main() {
  const jsonPath = join(ROOT, 'variables.json')
  const mdPath = join(ROOT, 'VARIABLES.md')
  if (process.argv.includes('--check')) {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const p = validate(data)
    if (readFileSync(mdPath, 'utf8') !== markdown(data)) p.push('VARIABLES.md differs from variables.json: run node tools/variables.mjs')
    if (JSON.stringify(data.excluded) !== JSON.stringify(EXCLUDED)) p.push('the exclusion list in variables.json is out of date')
    const codes = loadNotices([]).map((n) => n.code)
    for (const c of codes) if (!data.notices[c]) p.push(`${c} is not in variables.json`)
    for (const c of Object.keys(data.notices)) if (!codes.includes(c)) p.push(`variables.json has ${c}, which is not a notice`)
    p.forEach((x) => console.error(`✗ ${x}`))
    console.log(`[variables] ${codes.length} notices, ${p.length} problem(s)`)
    process.exit(p.length ? 1 : 0)
  }
  const jobs = []
  for (const n of loadNotices([]).flatMap(casesOf)) {
    if (!ZONES[n.code]) throw new Error(`${n.code} has no zones in tools/variables.mjs`)
    const transport = n.files.includes('email.txt.tt') ? 'email' : 'print'
    for (const mode of ['full', 'bare'])
      jobs.push({ code: n.code, module: n.module, transport, is_html: false, title: 'probe', content: probeTemplate(ZONES[n.code]),
        scenario: n.scenario, print_as: n.print_as, case: n.case, probe: mode })
  }
  const res = runKoha(jobs)
  if (res.leaked?.length) {
    console.error(`STOP: the rollback did not hold, Koha still has: ${res.leaked.join(', ')}. Remove them by hand.`)
    process.exit(3)
  }
  const bad = res.results.map((r, i) => [r, jobs[i]]).filter(([r]) => !r.ok)
  if (bad.length) {
    for (const [r, j] of bad) console.error(`FAIL ${j.code} ${j.case} ${j.probe}: ${r.error}`)
    process.exit(1)
  }
  const data = { $schema: './variables.schema.json', koha: res.koha, excluded: EXCLUDED, notices: {} }
  let empty = 0
  for (const code of [...new Set(jobs.map((j) => j.code))]) {
    const runs = jobs.flatMap((j, i) => (j.code === code ? [{ mode: j.probe, case: j.case, db: res.results[i].db, blocks: parseOutput(res.results[i].content) }] : []))
    const zones = ZONES[code]
    for (const z of zones) if (!runs.some((r) => r.mode === 'full' && r.blocks.some((b) => b.zone === z.zone))) { empty++; console.error(`FAIL ${code}: the zone "${z.zone}" was never printed`) }
    const all = zones.map((z) => judge(z, runs))
    const rej = all.flatMap((a) => a.rejected)
    const rejected = []
    for (const { zone, ...r } of rej) {
      const same = rejected.find((o) => o.key === r.key && o.reason === r.reason && o.expression === r.expression)
      if (same) same.valid_in.push(zone)
      else rejected.push({ ...r, valid_in: [zone] })
    }
    data.notices[code] = { zones: zones.map((z) => z.zone), note: NOTES[code] ?? '', variables: merge(all.flatMap((a) => a.ok)), rejected }
    console.log(`${code.padEnd(20)} ${data.notices[code].variables.length} proved, ${rejected.length} left out, ${runs.length} runs`)
  }
  const p = validate(data)
  p.forEach((x) => console.error(`✗ ${x}`))
  if (p.length || empty) process.exit(1)
  writeFileSync(jsonPath, JSON.stringify(data, null, 1) + '\n')
  writeFileSync(mdPath, markdown(data))
  console.log(`\nKoha ${res.koha}: ${Object.values(data.notices).reduce((n, x) => n + x.variables.length, 0)} values proved in ${jobs.length} runs`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e.stderr ? e.stderr.toString() : e)
    process.exit(2)
  })
