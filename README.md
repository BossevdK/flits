# Flits

Bestanden en tekst direct tussen je telefoon en pc sturen, via je eigen wifi. Geen account, geen cloud.

- `windows/` – Windows-app (Electron). Bouwen: `npm install`, dan `npm run dist` → `dist/Flits.exe`.
- `android/` – Android-app (Kotlin + Compose). Bouwen: `gradle assembleRelease` → `app/build/outputs/apk/release/app-release.apk`.

## Hoe het werkt

| Onderdeel | Techniek |
|---|---|
| Apparaten vinden | UDP-broadcast op poort 53318, elke 3 s (`{app:"flits", id, name, type, port}`) |
| Handmatig koppelen | IP-adres invoeren; de app vraagt `GET /info` op |
| Versturen | HTTPS (zelfondertekend certificaat) op poort 53317 |
| Toestemming | `POST /offer` blijft open tot de ontvanger accepteert (max 60 s) |
| Bestanden | `PUT /upload/<token>/<id>` met de ruwe bytes, rechtstreeks gestreamd |
| Annuleren | `POST /cancel/<token of offerId>` |

Beide apps spreken exact hetzelfde protocol (`windows/src/core.js` en `android/.../Engine.kt`).

## Testen

`node windows/test/selftest.js` start twee Flits-instanties op één pc en test ontdekken, grote bestanden,
mappen, tekst, weigeren, onthouden, annuleren en intrekken.
`node windows/test/fakephone.js` doet zich voor als telefoon om de Windows-app handmatig te proberen.
