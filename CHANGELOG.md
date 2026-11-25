# Changelog

Versions follow [semantic versioning](https://semver.org/). A change to a notice's "Your library" block (the lines
a library edits) is a major version: it can break a copy a library has already customised.

## 1.0.0 (2026-11-25)

First release: 18 notices, 159 of 159 checks passed on Koha 26.05.02.

- CHECKOUT, CHECKIN (email HTML, email text, SMS) and ISSUESLIP (80 mm receipt printer), each run through a real
  Koha checkout, check-in or slip print by `tools/render.mjs`.
- PREDUE, DUE (email HTML, email text, SMS) and ODUE, ODUE2, ODUE3 (also print), each produced by Koha's own
  advance_notices.pl or overdue_notices.pl. Overdues are tested with no fine, with a fine and with a restricted account.
- HOLD, HOLD_REMINDER (email HTML, email text, SMS, print) and AUTO_RENEWALS (email HTML, email text, SMS). Waiting
  holds are made with Koha's own code; the reminder and the renewals come from Koha's own cron scripts, run inside the
  rolled-back transaction. AUTO_RENEWALS is tested in 13 situations: 3 renewed, 9 not renewed, 1 unknown reason.
- PREDUEDGST, DUEDGST, HOLDDGST and AUTO_RENEWALS_DGST (email HTML, email text, SMS), for patrons who chose "Digests
  only", each produced by Koha's own digest code with one item and with several.
- WELCOME (email HTML, email text, print), MEMBERSHIP_EXPIRY (also SMS) and PASSWORD_RESET (email HTML, email text),
  through Koha's patron import, membership_expiry.pl and password recovery; nothing is sent and no key is kept.
- `tools/install.mjs`: dry run, install with a backup, restore; `tools/e2e-install.mjs` proves it on a test Koha.
- `tools/branding.mjs` and `tools/tokens.mjs`: one tested way to put a library's values into a template (TOKENS.md).
- VARIABLES.md and variables.json: the values each notice can print, proved by `tools/variables.mjs`.
- Previews drawn from what Koha produced (phone, desktop, SMS, print), checked for width, contrast and missing images.
- `tools/test-live.sh` writes the run log attached to each release; `tools/release.sh` refuses a release without a
  passing log for the notices being released.
