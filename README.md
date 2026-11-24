# koha-notice-templates

Clean, mobile-friendly notices for Koha: ready-to-paste templates for *Tools → Notices and slips*, each run through
a real Koha checkout, check-in or slip print before it is published.

> **Work in progress.** Version 1.0.0 is not out yet. The notices below already pass the live test; the rest of the
> set, the previews and the install tool follow.

| Code | Koha menu | What it is | Email (HTML) | Email (text) | SMS | Print |
|---|---|---|---|---|---|---|
| `CHECKOUT` | Circulation | receipt for the items borrowed in one visit | ✓ | ✓ | ✓ | |
| `CHECKIN` | Circulation | receipt for the items returned in one visit | ✓ | ✓ | ✓ | |
| `ISSUESLIP` | Circulation | checkout slip for an 80 mm receipt printer | | | | ✓ |

## Using one

1. In Koha, open *Tools → Notices and slips*, find the code, and **copy the current text somewhere safe** first.
2. Paste the template into the matching tab (Email, SMS or Print). For an email, tick *HTML message* when you use the
   `.html.tt` file and leave it unticked for the `.txt.tt` one.
3. Change only the values in the **"Your library"** block at the top: the name, logo address, colour and footer line.

CHECKOUT and CHECKIN keep Koha's two `----` lines: Koha repeats the part between them once per item, so one visit
sends one message.

## How the notices are tested

`node tools/render.mjs` runs every template inside a real Koha (a
[koha-testing-docker](https://gitlab.com/koha-community/koha-testing-docker) instance): it saves the template as the
notice, checks items out and in with Koha's own code (or prints the slip), reads the message Koha queued, and rolls
everything back. It fails on a Koha error, a value that printed empty, or a digest that is not one message.
`node tools/lint.mjs` checks the layout and the Template Toolkit syntax in CI.

## Licence

GPL-3.0-or-later, the same as Koha: these templates are adapted from Koha's own default notices.

<!-- about:start -->
## About Koha Solutions

**Koha Solutions** helps libraries run Koha well: Koha hosting, migration and support for libraries worldwide.
Our mission: empowering libraries with smart digital solutions.

We work with college, university, school and public libraries, entirely online. What we do:

- **Koha Cloud** ([myopac.com](https://myopac.com)): Koha's library workflows as a fully managed service. We set it
  up, host it, back it up and upgrade it, so the library can look after its readers instead of a server.
- **Koha Certificate** ([kohasolutions.com/koha-certificate](https://kohasolutions.com/koha-certificate)): Koha
  training on a running library system, with assignments scored from the work trainees actually do.
- **Custom websites** for libraries and institutions, built by the same team
  ([kohasolutions.com/custom-website](https://kohasolutions.com/custom-website)).
- **Services** for libraries that run their own Koha: installation, migration from other systems, support,
  customisation, RFID and multilingual catalogues ([kohasolutions.com/koha-services](https://kohasolutions.com/koha-services)).

The tools in this organisation are free and open source, built from the problems we solve for libraries every day.
Practical answers to everyday Koha questions are in our [knowledge base](https://kohasolutions.com/knowledge-base).

**Talk to us:** [kohasolutions.com/contact](https://kohasolutions.com/contact) ·
[LinkedIn](https://www.linkedin.com/company/kohasolutions) · [YouTube](https://www.youtube.com/@kohasolutions) ·
[GitHub](https://github.com/kohasolutions)
<!-- about:end -->

---
Not affiliated with or endorsed by the Koha Community. Koha is free software: https://koha-community.org/
