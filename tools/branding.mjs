// The "Your library" block: the one place that knows how a library's values are written into a template and into a
// preview. No dependencies, runs in Node and in a browser. The contract is in TOKENS.md.
// SPDX-License-Identifier: GPL-3.0-or-later

/** @typedef {{ name?: string, logo?: string, colour?: string, footer?: string }} Branding */

/** @type {Record<'name' | 'logo' | 'colour' | 'footer', { variable: string, token: string }>} */
export const FIELDS = {
  name: { variable: 'library_name', token: '__LIBRARY_NAME__' },
  logo: { variable: 'logo_url', token: '__LOGO_URL__' },
  colour: { variable: 'brand_colour', token: '__BRAND_COLOUR__' },
  footer: { variable: 'footer_note', token: '__FOOTER_NOTE__' },
}
const KEYS = /** @type {(keyof typeof FIELDS)[]} */ (Object.keys(FIELDS))

/** One line, no control characters, no spaces at the ends. @param {string | undefined} v */
export const clean = (v) =>
  (v ?? '')
    .replace(/[\p{Cc}\u2028\u2029\s]+/gu, ' ')
    .trim()

/** @param {string} v */
const htmlEncode = (v) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** The value as it appears in the notice. @param {string | undefined} v @param {boolean} isHtml */
export const shown = (v, isHtml) => (isHtml ? htmlEncode(clean(v)) : clean(v))

/** A Template Toolkit literal that prints exactly this text. Single quotes: nothing is interpolated in them, and
 * only \ and ' are special. (In double quotes Template Toolkit reads an escaped backslash followed by n as a line
 * break, so no escaping is safe there.) "%]" would end the tag even inside quotes, so it is joined from two pieces.
 * @param {string} text */
export const ttLiteral = (text) => `'${text.replace(/[\\']/g, '\\$&').replace(/%(?=\])/g, "%' _ '")}'`

/** What is wrong with these values; an empty object when nothing is. @param {Branding} b */
export function problemsWith(b) {
  /** @type {Partial<Record<keyof typeof FIELDS, string>>} */
  const p = {}
  for (const k of /** @type {const} */ (['name', 'footer'])) {
    const v = clean(b[k])
    if (v.includes('<<')) p[k] = 'Koha removes or replaces text after "<<": please leave it out.'
    else if (v.includes('----')) p[k] = 'Koha treats four hyphens as a separator: please use fewer.'
  }
  const logo = clean(b.logo)
  if (logo) {
    let ok = !/\s/.test(logo) && !logo.includes('<<') && !logo.includes('----')
    try {
      ok = ok && new URL(logo).protocol === 'https:'
    } catch {
      ok = false
    }
    if (!ok) p.logo = 'The logo must be a full address that starts with https://'
  }
  const colour = clean(b.colour)
  if (colour && !/^#[0-9a-f]{6}$/i.test(colour)) p.colour = 'The colour must look like #1f4e79'
  return p
}

/** The template with these values in its "Your library" block and nothing else changed. A value left out keeps the
 * template's own (the library name Koha knows, no logo, the default colour, no footer line).
 * @param {string} template @param {Branding} b @param {boolean} isHtml */
export function fillTemplate(template, b, isHtml) {
  const bad = Object.values(problemsWith(b))
  if (bad.length) throw new Error(bad[0])
  return writeBlock(template, b, isHtml)
}

/** @param {string} template @param {Branding} b @param {boolean} isHtml */
function writeBlock(template, b, isHtml) {
  const end = template.indexOf('-%]')
  if (!template.startsWith('[%-') || end < 0) throw new Error('the template has no "Your library" block')
  let block = template.slice(0, end)
  for (const k of KEYS) {
    if (!clean(b[k])) continue
    const line = new RegExp(`^([ ]*${FIELDS[k].variable}[ ]*= )(?:branch\\.branchname|"[^"\\n]*");`, 'm')
    if (line.test(block)) block = block.replace(line, (_, start) => `${start}${ttLiteral(shown(b[k], isHtml))};`)
  }
  return block + template.slice(end)
}

/** The template with tokens instead of values; which of logo and footer are set is the variant.
 * @param {string} template @param {{ logo: boolean, footer: boolean }} set */
export const tokenTemplate = (template, set) =>
  writeBlock(
    template,
    {
      name: FIELDS.name.token,
      colour: FIELDS.colour.token,
      logo: set.logo ? FIELDS.logo.token : '',
      footer: set.footer ? FIELDS.footer.token : '',
    },
    true,
  )

/** Which logo and footer combinations a template can show. @param {string} template */
export function variantsOf(template) {
  const has = (/** @type {string} */ v) => new RegExp(`^ *${v} *=`, 'm').test(template.slice(0, template.indexOf('-%]')))
  const out = []
  for (const logo of has('logo_url') ? [false, true] : [false])
    for (const footer of has('footer_note') ? [false, true] : [false]) out.push({ logo, footer })
  return out
}

/** @param {{ logo: boolean, footer: boolean }} set */
export const variantKey = (set) => (set.logo ? 'logo' : 'nologo') + '+' + (set.footer ? 'footer' : 'nofooter')

/** Koha's output for these values: picks the variant Koha rendered and puts the values where the tokens are, in one
 * pass, so a value that happens to contain a token is not replaced again.
 * @param {Record<string, string>} rendered @param {Branding} b @param {boolean} isHtml
 * @param {{ name: string, colour: string }} defaults what the template prints when the value is left out, as Koha
 * prints it (not encoded) */
export function fillPreview(rendered, b, isHtml, defaults) {
  const want = { logo: !!clean(b.logo), footer: !!clean(b.footer) }
  const text =
    rendered[variantKey(want)] ??
    rendered[variantKey({ logo: false, footer: want.footer })] ??
    rendered[variantKey({ logo: false, footer: false })]
  if (text === undefined) throw new Error('no rendered variant')
  /** @type {Record<string, string>} */
  const values = {
    [FIELDS.name.token]: shown(b.name, isHtml) || defaults.name,
    [FIELDS.colour.token]: clean(b.colour) || defaults.colour,
    [FIELDS.logo.token]: shown(b.logo, isHtml),
    [FIELDS.footer.token]: shown(b.footer, isHtml),
  }
  return text.replace(/__(?:LIBRARY_NAME|LOGO_URL|BRAND_COLOUR|FOOTER_NOTE)__/g, (t) => values[t] ?? t)
}
