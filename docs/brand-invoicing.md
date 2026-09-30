# Brand-fakturering og mailafsendelse — opsætning og brug

Sådan lader du **ét selskab fakturere under flere brands**, og sådan sender du
den udstedte faktura ud af huset som mail med PDF vedhæftet.

To adskilte ting, som bare ofte bruges sammen:

1. **Brand-identitet på fakturaen** (`--brand`) — ændrer kun hvordan fakturaen
   *ser ud*. Samme CVR, samme ledger, samme fortløbende nummerserie.
2. **Afsendelse via SMTP2GO** (`scripts/send-invoice-smtp2go.ts`) — et
   selvstændigt script uden for kernen, der læser den udstedte faktura og
   leverer den.

> **Status:** bygget og i daglig brug hos ét rigtigt selskab siden august 2026 —
> fakturaer er sendt live til rigtige kunder. De rene, deterministiske dele er
> dækket af tests (68 i alt: PNG-dekoderen, brand-indlæsningen og
> afsendelsesvinduet). Selve netkaldet til SMTP2GO og PDF-renderingen er det
> ikke. Se [Hvad der mangler](#hvad-der-mangler) før du bygger videre eller
> åbner en PR mod `main`.

Relateret: [cli-contract.md](cli-contract.md), [build-loop.md](build-loop.md),
[efaktura-digisense.md](efaktura-digisense.md) (den certificerede vej til
*offentlige* modtagere — dette dokument handler om almindelig mail til private
virksomheder).

---

## Overblik

| Hvad | Hvor | Kommando / flag |
|------|------|-----------------|
| Brand-identiteter | `config/brands.json` | `invoice create --brand <key>` |
| Mailskabelon | `config/faktura-mail.html` | *(læses automatisk)* |
| Kontaktpersoner | `config/kontaktpersoner.json` | *(læses automatisk)* |
| SMTP2GO-nøgle | `config/smtp.json` | *(læses automatisk)* |
| Send faktura eller rykker | — | `bun run scripts/send-invoice-smtp2go.ts` |
| Se / annullér køsatte mails | — | `bun run scripts/scheduled-mails.ts` |

Alle fire konfigurationsfiler ligger i **virksomhedens egen mappe**, ikke i
repoet. De er data, ikke kode: ejeren retter navne, mails og logoer uden at røre
kildekoden — samme snit som `digisense.json`.

---

## Del 1 — Brands

### Problemet

Et dansk selskab må have **binavne**. "Den langhårede konsulent ApS" kan lovligt
fakturere som "Mind AI ApS" — samme juridiske enhed, samme CVR. Men kunden skal
kunne se hvem hun handler med, og de to brands har hver sin mail, sit telefonnummer
og sit logo.

Det der **ikke** må ske, er at brandet river fakturanummereringen over.
Momsbekendtgørelsen §58 tillader "én eller flere serier", men hver serie skal
være fortløbende og uden huller. Den simple og sikre løsning er én fælles serie
for alle brands — og det er den, der er implementeret.

### `config/brands.json`

```json
{
  "default": "dlk",
  "latePaymentNote": "Ved betaling efter forfald tilskrives der renter på 0,81% pr. påbegyndt måned samt et gebyr på 100,00 DKK.",
  "brands": {
    "dlk": {
      "name": "Den langhårede konsulent ApS",
      "address": "Bøgevej 7, 4330 Hvalsø",
      "vatOrCvr": "DK12345678",
      "email": "kontakt@eksempel.dk",
      "phone": "12345678",
      "web": "www.eksempel.dk",
      "logoPath": "C:/sti/til/logo.png"
    },
    "mindai": {
      "name": "Mind AI ApS",
      "email": "bogholder@andeteksempel.dk",
      "logoText": "Mind AI ApS"
    }
  }
}
```

| Felt | Betydning |
|------|-----------|
| `default` | Brand der bruges når `--brand` udelades |
| `latePaymentNote` | Morarente-note, printes på **alle** fakturaer |
| `name` | Sælgernavnet på fakturaen (påkrævet) |
| `address`, `vatOrCvr` | Overskrives af eksplicitte `--seller-*` flag |
| `email`, `phone`, `web` | Kontaktlinjen i fakturaens footer |
| `logoText` | Kort ordmærke i headeren. Standard: `name` |
| `logoPath` | PNG-logo i headeren i stedet for ordmærket |

### Brug

```bash
bun run src/cli.ts invoice create --company <path> \
  --issue-date 2026-08-30 --customer-id 1 \
  --line "Konsulenttimer|3|1200" \
  --brand mindai --actor user:anders
```

### Hvad et brand IKKE ændrer

- **Fakturanummeret.** Alle brands trækker på samme fortløbende serie. Udsteder
  du 0003 som DLK og 0004 som Mind AI, er serien stadig hel.
- **CVR-nummeret.** Der er ét selskab. `vatOrCvr` på brandet er til at skrive
  det samme nummer pænt, ikke til at skifte enhed.
- **Bogføringen.** Brandet rører ikke en eneste journalpostering.

### Logoet fryses ved udstedelse

`logoPath` læses **én gang**, når fakturaen udstedes, og bytes lægges ind i
fakturaens snapshot. Udskifter du logofilen to år senere, gengives den gamle
faktura stadig præcis som den blev sendt. Det er determinisme-kravet fra
[build-loop.md](build-loop.md) anvendt på et billede.

Er PNG'en ulæselig, falder headeren tilbage til `logoText` — et dårligt logo
vælter ikke en faktura. Understøttet: 8-bit, ikke-interlaced, farvetype 0/2/4/6.
Palette-PNG (type 3), 16-bit og Adam7 afvises. Se `src/core/png-image.ts` for
hvorfor dekoderen er håndrullet.

---

## Del 2 — Mailen

### `config/faktura-mail.html`

En almindelig HTML-fil med flettefelter. Findes den ikke, bruges en indbygget
fallback-tekst.

| Felt | Indhold |
|------|---------|
| `{{kontaktnavn}}` | Modtagerens fornavn (se Del 4) |
| `{{brand}}` | Afsendende brands navn |
| `{{fakturanummer}}` | Fakturanummeret |
| `{{fakturadato}}` | Dansk datoformat, fx "30. august 2026" |
| `{{beløb}}` | Bruttobeløb med valuta, fx "4.500,00 DKK" |
| `{{signatur}}` | Brandets HTML-signatur |

Emnelinjer og skabelonstier sættes i `brands.json` under `mail`:

```json
"mail": {
  "subject": "Faktura af {{fakturadato}} fra {{brand}}",
  "templatePath": "config/faktura-mail.html",
  "reminderSubject": "Betalingspåmindelse for faktura {{fakturanummer}} fra {{brand}}",
  "reminderTemplatePath": "config/rykker-mail.html"
}
```

Signaturen hentes fra brandets `signaturePath` og strippes for HTML-kommentarer,
så en signatur eksporteret fra et mailprogram kan bruges direkte.

---

## Del 3 — Afsendelse

```bash
bun run scripts/send-invoice-smtp2go.ts \
  --company <path> --invoice-number 2026-27-0001 --to kunde@eksempel.dk
```

| Flag | Betydning |
|------|-----------|
| `--company` | Virksomhedens mappe (påkrævet) |
| `--invoice-number` | Den udstedte faktura (påkrævet) |
| `--to` | Modtagermail. Udelades → køberens mail fra fakturaen |
| `--kind` | `invoice` (standard) eller `reminder` |
| `--attention` | Fornavn i hilsenen. Vinder over `kontaktpersoner.json` |
| `--schedule` | `"2026-09-01 08:00"`, ISO 8601, eller `next` |
| `--live` | **Påkrævet for at sende noget som helst** |
| `--ignore-send-window` | Nødudgang uden om tidsvinduet |
| `--html-out` | Skriv den færdige HTML-krop til en fil (til inspektion) |
| `--actor` | Hvem der handler (standard `user:anders`) |

### Sikkerhedsmodellen

**Dry-run som standard.** Uden `--live` sendes intet. Scriptet printer afsender,
modtager, emne, flettefelter og API-nøglen som `***REDACTED***`. Man kan altså
altid se præcis hvad der ville gå ud, før noget går ud.

**Afsendelsesvindue: hverdage kl. 8–15** (lokal tid). Reglerne selv bor i
`src/core/send-window.ts` — rene funktioner der tager deres input eksplicit
(`parseSchedule` får `now` ind i stedet for at læse uret), så de kan testes uden
at køre scriptet. `--live` uden for vinduet afvises med besked om næste gyldige
tidspunkt. Baggrunden er triviel og rigtig:
en faktura der rammer kundens indbakke søndag kl. 23 ser forkert ud. Dry-run
advarer men kører, så man kan klargøre når som helst. **Scriptet kender ikke
danske helligdage** — dem må man selv holde øje med.

**`--schedule next`** vælger automatisk næste gyldige tidspunkt i vinduet, så man
slipper for at hovedregne sommertid. SMTP2GO tager imod mailen nu og leverer
senere; grænsen er 3 døgn frem.

### Rækkefølgen der gør loggen sand

Rentemesters eget `email_send_log` opdateres **først efter** SMTP2GO har
bekræftet modtagelse (HTTP 200 + `succeeded`). Det kræver `"dryRun": true` i
`config/smtp.json`, så kernens indbyggede transport logger i stedet for at
fejle. Pointen: loggen siger "sendt", når der faktisk er sendt — ikke når vi
havde tænkt os at sende.

Sporing tre steder: scriptets egen `invoices/smtp2go-delivery.log`, SMTP2GOs
dashboard via `email_id`, og Rentemesters `email_send_log`.

---

## Del 4 — Kontaktpersoner

Hilsenen skal helst være "Hej Tue", ikke "Hej Grønne Leverum ApS". Men
Rentemesters kundekartotek har **intet kontaktperson-felt**, `customers` er
append-only uden update-kommando, og `UNIQUE(vat_or_cvr, name)` blokerer en ny
række på samme kunde. Navnet kan altså ikke bo i kartoteket uden en
schema-migration af den levende bogføringsdatabase.

Derfor en lille fil ved siden af — ren præsentation, rører hverken ledger eller
revisionsspor:

```json
{
  "kontakter": [
    { "cvr": "DK12345678", "email": "tue@eksempel.dk", "navn": "Tue" }
  ]
}
```

Opslag sker på køberens CVR fra fakturaen, ellers på modtagermailen.
Rækkefølge: `--attention` → `kontaktpersoner.json` → firmanavn → `"kunde"`.

**Kendt kant:** opslaget matcher primært på CVR, så sender du med `--to` til en
anden person i samme firma, står der stadig kontaktpersonens navn. Brug
`--attention` der.

---

## Del 5 — Køsatte mails

```bash
bun run scripts/scheduled-mails.ts list --company <path>
bun run scripts/scheduled-mails.ts cancel --company <path> --schedule-id <id> --yes
```

`cancel` er dry-run som standard: den slår først op hvad der ville blive
annulleret, viser det, og kræver `--yes` for at gøre alvor af det.

---

## Designvalget: hvorfor afkoblet fra kernen

`EmailTransport.send()` i kernen er **synkron**. Et rigtigt netkald er det ikke.
At gøre den asynkron ville ramme `sendInvoiceEmail` plus fire kaldssteder (CLI,
MCP og to cockpit-write-handlers, alle confirm-gatede) og deres tests.

I stedet er afsendelsen et selvstændigt script, der kun **læser** Rentemesters
output: den udstedte fakturas snapshot, dens PDF og `config/*`. Kernen er
uændret, determinismen i den er uantastet, og scriptet kan udskiftes uden at
røre bogføringen.

Prisen er ærlig: afsendelsen er ikke dækket af kernens tests eller
confirm-kontrakt. Den er et værktøj ved siden af, ikke en del af ledgeren.

---

## Hvad der mangler

Ærlig liste over hvad der stadig står tilbage:

- **Testdækningen er delvis.** Dækket er de rene, deterministiske enheder:
  `src/core/png-image.ts` (23 tests — alle fem scanline-filtre,
  alfa-komposition mod hvid, og hver enkelt afvisningsgrund),
  `src/core/brands.ts` (17 tests — opslag, default, og at indlæsningen aldrig
  kaster uanset hvad der står i filen) og `src/core/send-window.ts` (28 tests
  — vinduets grænser, weekendspring og schedule-parsing). Alle tre suiter er
  muteringstestet: knæk prædiktoren i Paeth-filteret, komponér alfa mod sort,
  ryk vinduets lukketid en time, fjern weekendspringet, eller drop navnekravet
  på et brand — hver enkelt mutation fanges.
  **Ikke dækket:** HTTP-kaldet til SMTP2GO (kræver en fake),
  mailkompositionen i `scripts/send-invoice-smtp2go.ts`, og PDF-renderingen i
  `src/core/invoice-pdf.ts`.
- **Logo som `cid:`-vedhæftning.** Signaturens logo hentes fra en ekstern URL og
  blokeres af mailklienter der ikke henter billeder.
- **Ingen helligdagskalender** i afsendelsesvinduet.
- **`Enhed`-kolonne på fakturaen.** `unitCode` findes i datamodellen, men
  renderes ikke.
- **Separate nummerserier pr. brand** er lovligt muligt, men ikke implementeret.
  Kræver en ændring af nummereringsskemaet.
- **Sprog i kommentarer** er blandet: `src/`-filerne er på engelsk som resten af
  kernen, `scripts/scheduled-mails.ts` er på dansk.

---

## Oprindelse og forfatterskab

Denne funktionalitet er udviklet af **Anders van Amerongen** (Den langhårede
konsulent ApS / Mind AI ApS) som product owner og ansvarlig forfatter, med
**Claude Opus** (Anthropic) som udviklende part. Koden er skrevet af modellen ud
fra Anders' specifikation, afprøvning og beslutninger — de tidlige commits af
Claude Opus 4.8, de seneste af Claude Opus 5.

**Anders er ikke udvikler af uddannelse.** Det er værd at vide for den, der
læser koden: arkitekturvalgene er truffet i dialog med modellen, ikke ud fra
mange års erfaring med TypeScript. Vurdér koden derefter — og sig til, hvis noget
er gjort på en omvej.

Funktionaliteten er ikke teoretisk. Den kører det rigtige bogholderi for to
danske ApS'er, og fakturaerne er sendt til rigtige kunder.

I henhold til [CONTRIBUTING.md](../CONTRIBUTING.md) er mennesket forfatteren:
fejl i koden er Anders' ansvar, ikke modellens. Alle commits på branchen bærer
trailer-linjen `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.
