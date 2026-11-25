# Tested

Written by `tools/tested.mjs` from a run of `tools/render.mjs`; never edited by hand.

- **Koha:** 26.05.02.002
- **Date:** 2026-11-25
- **Result:** 159 of 159 checks passed

Each check saves the template as the notice in a running Koha, makes the real event happen with Koha's own code, reads
the message Koha made and rolls everything back.

| Notice | Formats | Situations | Passed |
|---|---|---|---|
| `AUTO_RENEWALS` | email (HTML), email (text), SMS | renewed, auto renew final, auto unseen final, too many, on reserve, restriction, overdue, too unseen, auto account expired, auto too late, auto too much owing, item denied renewal, unknown reason | 39 of 39 |
| `AUTO_RENEWALS_DGST` | email (HTML), email (text), SMS | renewed, last renewal, not renewed, mixed | 12 of 12 |
| `CHECKIN` | email (HTML), email (text), SMS | — | 3 of 3 |
| `CHECKOUT` | email (HTML), email (text), SMS | — | 3 of 3 |
| `DUE` | email (HTML), email (text), SMS | — | 3 of 3 |
| `DUEDGST` | email (HTML), email (text), SMS | one, three | 6 of 6 |
| `HOLD` | email (HTML), email (text), print, SMS | — | 4 of 4 |
| `HOLDDGST` | email (HTML), email (text), SMS | one, three, two libraries | 9 of 9 |
| `HOLD_REMINDER` | email (HTML), email (text), print, SMS | one, three | 8 of 8 |
| `ISSUESLIP` | print | — | 1 of 1 |
| `MEMBERSHIP_EXPIRY` | email (HTML), email (text), print, SMS | — | 4 of 4 |
| `ODUE` | email (HTML), email (text), print, SMS | no fine, fine, restricted, many | 16 of 16 |
| `ODUE2` | email (HTML), email (text), print, SMS | no fine, fine, restricted, many | 16 of 16 |
| `ODUE3` | email (HTML), email (text), print, SMS | no fine, fine, restricted, many | 16 of 16 |
| `PASSWORD_RESET` | email (HTML), email (text) | library name set, library name empty | 4 of 4 |
| `PREDUE` | email (HTML), email (text), SMS | — | 3 of 3 |
| `PREDUEDGST` | email (HTML), email (text), SMS | one, three | 6 of 6 |
| `WELCOME` | email (HTML), email (text), print | own user name, card as user name | 6 of 6 |
