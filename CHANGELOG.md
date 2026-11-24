# Changelog

Versions follow [semantic versioning](https://semver.org/). A change to a notice's "Your library" block (the lines
a library edits) is a major version: it can break a copy a library has already customised.

## Unreleased

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
