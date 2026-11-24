# The branding contract

Anything that puts a library's values into these notices uses `tools/branding.mjs`, and nothing else. It has no
dependencies and runs in Node and in a browser.

## Values

| Value | Variable in the block | Token | Left out |
|---|---|---|---|
| name | `library_name` | `__LIBRARY_NAME__` | the name Koha has (`branch.branchname`; PASSWORD_RESET: `LibraryName`, else `Your library`) |
| logo | `logo_url` | `__LOGO_URL__` | no logo |
| colour | `brand_colour` | `__BRAND_COLOUR__` | `#1f4e79` |
| footer | `footer_note` | `__FOOTER_NOTE__` | no line |

Not every template has every value: an SMS has only the name, a text email the name and the footer.

## Writing a value into a template (`fillTemplate`)

1. Line breaks and control characters become one space; spaces at the ends go.
2. In an HTML template the value is HTML-encoded (`& < > " '`): the templates print it as it is.
3. It becomes a **single-quoted** Template Toolkit literal: `\` and `'` get a backslash, and `%]` is written
   `'%' _ ']'`. Double quotes are not used: there Template Toolkit turns an escaped backslash followed by `n` into
   a line break, and reads `$`.
4. Only that line of the "Your library" block changes.

Refused, because Koha itself would damage them after Template Toolkit has run: `<<` (Koha replaces or removes
`<<…>>`) and `----` (a digest separator). A logo must be an `https://` address, a colour `#rrggbb`.

## Previews (`out/bundle.json`, made by `tools/tokens.mjs`)

Every notice, file and case is rendered by a real Koha with the tokens as its values. A logo and a footer sit inside
`IF`, so a file is rendered once for each combination it can show (`nologo+nofooter`, `logo+footer`, …): four for HTML,
two for text, one for SMS. `fillPreview` takes the matching one and puts the values (encoded as in step 2) in, in one
pass. The bundle also carries each template's source, the subject, the Koha release and this repository's commit;
Each case has its own `defaults` (pass those to `fillPreview`): what Koha prints for a value left out is not the same
in every case (PASSWORD_RESET prints `Your library` when the preference `LibraryName` is empty; `prints_name` in
`notice.json`). `dirty: true` means the templates or tools had uncommitted changes when it was made.

`node tools/tokens.mjs --prove` renders every case again through Koha with the values in `PROOF` (quotes, HTML,
backslashes, `$`, `%]`, other scripts, values that look like tokens) and requires the same text, character for
character. The one thing ignored is the minute on the printed slip.

## What it does not do

The subject uses the library name from Koha, not the one typed in.
