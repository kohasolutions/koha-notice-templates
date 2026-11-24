// The live proof is tools/tokens.mjs --prove (real Koha); these catch the rule being changed, without a Koha.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { clean, fillPreview, fillTemplate, problemsWith, shown, tokenTemplate, ttLiteral, variantKey, variantsOf } from '../tools/branding.mjs'
import { sameTime } from '../tools/tokens.mjs'

const dir = new URL('../notices/', import.meta.url).pathname
const all = readdirSync(dir).flatMap((c) => readdirSync(dir + c).filter((f) => f.endsWith('.tt')).map((f) => [c + '/' + f, readFileSync(`${dir}${c}/${f}`, 'utf8')]))

test('a Template Toolkit literal escapes \\ and \' and never closes the tag', () => {
  assert.equal(ttLiteral(`a'b\\c"$d`), `'a\\'b\\\\c"$d'`)
  assert.equal(ttLiteral('100%]x'), "'100%' _ ']x'")
  for (const v of ['%]', '%%]]', "'%]'"]) assert.ok(!ttLiteral(v).includes('%]'))
})

test('HTML is encoded once, text is not, and a value stays on one line', () => {
  assert.equal(shown(`<b>&"'`, true), '&lt;b&gt;&amp;&quot;&#39;')
  assert.equal(shown(`<b>&"'`, false), `<b>&"'`)
  assert.equal(clean(' a\r\n\tb '), 'a b')
})

test('every template: only the block changes, and only the lines that were given', () => {
  for (const [name, t] of all) {
    assert.equal(fillTemplate(t, {}, true), t, name)
    const out = fillTemplate(t, { name: 'X', logo: 'https://e.org/l.png', colour: '#000000', footer: 'F' }, true)
    const rest = (s) => s.slice(s.indexOf('-%]'))
    assert.equal(rest(out), rest(t), name)
    assert.match(out, /library_name = 'X';/, name)
    const diff = out.split('\n').filter((l, i) => l !== t.split('\n')[i]).length
    assert.equal(diff, ['library_name', 'logo_url', 'brand_colour', 'footer_note'].filter((v) => t.slice(0, t.indexOf('-%]')).includes(`${v} `)).length, name)
  }
})

test('every template lists its variants, and a token template holds exactly the tokens of its variant', () => {
  for (const [name, t] of all) {
    const v = variantsOf(t)
    assert.equal(v.length, name.includes('sms') ? 1 : name.includes('.txt') ? 2 : 4, name)
    for (const s of v) assert.equal(tokenTemplate(t, s).includes('__LOGO_URL__'), s.logo, name)
  }
  assert.equal(variantKey({ logo: true, footer: false }), 'logo+nofooter')
})

test('values Koha would damage are refused', () => {
  assert.deepEqual(problemsWith({ name: 'A & B', logo: 'https://e.org/a.png', colour: '#1F4e79', footer: 'x' }), {})
  assert.deepEqual(Object.keys(problemsWith({ name: 'a <<x>>', logo: 'http://e.org/a.png', colour: 'red', footer: 'a ---- b' })), ['name', 'footer', 'logo', 'colour'])
  for (const logo of ['javascript:alert(1)', 'l.png', 'https://e.org/<<a>>', 'https://e.org/a b.png']) assert.ok(problemsWith({ logo }).logo, logo)
  assert.throws(() => fillTemplate(all[0][1], { colour: 'red' }, true))
})

test('a value that looks like a token is not replaced again, and $& is plain text', () => {
  const r = { 'nologo+footer': '__LIBRARY_NAME__|__FOOTER_NOTE__' }
  assert.equal(fillPreview(r, { name: '__FOOTER_NOTE__', footer: '$&' }, false, { name: 'D', colour: '#1' }), '__FOOTER_NOTE__|$&')
})

test('the minute is ignored when two renders are compared, the date is not', () => {
  assert.equal(sameTime('11/24/2026 10:01'), sameTime('11/24/2026 10:02'))
  assert.notEqual(sameTime('11/24/2026 10:01'), sameTime('11/25/2026 10:01'))
})
