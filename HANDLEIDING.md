# Flits – handleiding om thuis verder te werken

Stand van zaken: **Windows 1.7** (Electron) en **Android 1.1** (Kotlin + Compose).
GitHub: `BossevdK/flits` (openbaar). Releases heten `vX.Y`. De Windows-app werkt zichzelf bij vanaf de laatste release.

## Wat zit waar

```
Flits/
  README.md            korte uitleg + protocol tussen de apps
  HANDLEIDING.md       dit bestand
  release.ps1          OUD script (bouwt beide apps tegelijk). Zie "Een release maken" hieronder.
  sleutel/             Android-ondertekeningssleutel + wachtwoorden. GEHEIM, nooit in git.
  windows/             Windows-app
    src/main.js          venster, tray, IPC, instellingen, opstarten/herstellen van de poort
    src/core.js          Flits-protocol: vinden (UDP), versturen/ontvangen (HTTPS), annuleren
    src/downloader.js    Downloaden van internet (zie verderop)
    src/updater.js       Bijwerken van Flits zelf (GitHub), ook in meerdere delen tegelijk
    src/preload.js       brug tussen venster en main.js
    src/renderer/        interface (index.html, app.js, style.css)
    test/                selftest.js, dltest.js, fakephone.js, portholder.js, slowserver.js
    build/               iconen voor de installer
  android/             Android-app (Kotlin, Compose); package nl.flits.app
  release/             laatste gebouwde Flits.apk / Flits.exe (niet in git, mag je weggooien)
```

## Thuis aan de slag

### Windows-app
1. Installeer Node.js (versie 20 of nieuwer) en Git.
2. In de map `windows`: `npm install` (haalt Electron en electron-builder op, duurt even).
3. Proberen: `npx electron .`
4. Testen (geen internet nodig, alles lokaal):
   - `node test/selftest.js` – twee Flits-instanties sturen bestanden/tekst naar elkaar.
   - `node test/dltest.js` – downloadmanager tegen een lokale testserver (delen, pauzeren, hervatten, storingen, delen van trage stukken).
   - `node test/slowserver.js` – trage testserver om de interface te bekijken; link: `http://127.0.0.1:8099/trage`.
5. Installer bouwen: `npm run dist` → `windows/dist/Flits.exe` (NSIS-installer, ongeveer 105 MB).

Handige testvariabelen voor `npx electron .`:
- `FLITS_SHOT=pad.png` maakt na een paar seconden een schermafbeelding en sluit af (`FLITS_SHOT_DELAY=ms`, `FLITS_SHOT_CLICK=#btn-settings` klikt eerst ergens op).
- `FLITS_FAKE_VERSION=1.0.0` doet alsof de app oud is, zodat de updater een nieuwe versie vindt.
- `FLITS_DL_TEST=<link>` start meteen een download.

### Android-app
Niet nodig om de Windows-app te ontwikkelen. Wil je de Android-app bouwen:
- JDK 17, Gradle 8.7, Android SDK met platform 34 en build-tools 34.0.0 (op de pc waar dit gemaakt is stond alles in `C:\Users\Gain\android-tools`).
- In `android/` een `local.properties` met `sdk.dir=...` naar de SDK.
- `gradle assembleRelease` → `android/app/build/outputs/apk/release/app-release.apk`.
- Er is geen emulator (virtualisatie stond uit): testen deed ik door de APK op de telefoon te installeren.
- Eerste bouw duurt lang (tot ~18 min), daarna een paar minuten. Stop Gradle daarna met `gradle --stop`.
- Versie staat in `android/app/build.gradle.kts` (`versionCode = 2`, `versionName = "1.1"`).

## Ondertekeningssleutel (Android) – belangrijk

- Staat in `sleutel/flits-release.jks`, met de wachtwoorden in `sleutel/keystore.properties`.
- **Elke Android-release moet met dezelfde sleutel zijn ondertekend**, anders kan de telefoon niet bijwerken.
- Raak je de sleutel kwijt, dan moet iedereen de app eerst verwijderen en opnieuw installeren. Maak dus een back-up.
- Zet `sleutel/` nooit in git of op GitHub (staat al in `.gitignore`). Het zipbestand met deze handleiding bevat de sleutel: bewaar het veilig.
- De Windows-app is niet ondertekend (geen certificaat): Windows SmartScreen kan een waarschuwing tonen.

## Een release maken (zoals het nu gaat)

`release.ps1` bouwt nog beide apps en gebruikt een versie als `1.2`. Voor alleen Windows ging het zo:

1. Versie ophogen in `windows/package.json` (`"version": "1.8.0"`).
2. Tests draaien (`selftest.js`, `dltest.js`), dan `npm run dist` in `windows/`.
3. Kopieer `windows/dist/Flits.exe` naar `release/Flits.exe`.
4. Committen en pushen (`git push`).
5. `gh release create v1.8 release/Flits.exe --repo BossevdK/flits --title "Flits 1.8 (Windows)" --notes "..."`.

Regels voor de updater:
- Windows zoekt in de laatste release een bestand dat op `.exe` eindigt en vergelijkt de tag (`v1.8`) met zijn eigen versie.
- Android zoekt een `.apk`. Zit er geen apk bij een release (zoals bij v1.2 tot v1.7), dan doet Android niets. Dat is zo bedoeld, maar controleer het als je de Android-app ooit bijwerkt.
- Een Windows-release mag dus alleen een `.exe` bevatten, een Android-release alleen een `.apk`, of allebei.

## Hoe de Windows-downloadmanager werkt (`src/downloader.js`)

- Je plakt een link; de schuif (1–16, standaard 8) bepaalt het aantal verbindingen.
- De server wordt gevraagd om stukken (`Range`). Kan dat, dan wordt het bestand in **evenveel delen verdeeld als verbindingen**. Elke verbinding haalt een eigen deel op. Is een verbinding klaar, dan **neemt ze de helft over van het stuk dat nog het langst duurt**, zodat één trage verbinding de rest niet ophoudt.
- Kan de server geen stukken, dan gaat het bestand in één keer (geen pauzeren/hervatten).
- Een stuk dat mislukt gaat terug in de rij; een verbinding die drie keer achter elkaar mislukt, haakt af en de rest gaat door (past zich zo aan servers aan die weinig verbindingen toestaan).
- Voortgang wordt bewaard in `downloads.json` (in de gegevensmap van Flits) en het halve bestand staat als `naam.part` in Downloads. Daardoor werkt pauzeren en hervatten, ook na het sluiten van Flits. Hervatten gaat niet vanzelf; je drukt op Hervatten.
- Is het bestand op de server veranderd (andere grootte of ETag), dan begint Flits opnieuw.
- De interface toont een pixelkaart (alleen visualisatie, gebaseerd op bytes) en de snelheid per verbinding.

## Dingen die ik onderweg geleerd heb

- **Schijf vol:** op de ontwikkel-pc was C: vaak helemaal vol. Dat gaf rare fouten (lege bestanden, mislukte tests). Houd een paar GB vrij; `windows/dist` en `windows/node_modules` zijn de grote boosdoeners en kunnen altijd opnieuw gemaakt worden.
- **CSP:** de interface staat `style-src 'self'` toe, dus inline `style="..."` via `setAttribute` wordt geblokkeerd. In `app.js` zet de hulpfunctie `el()` stijlen daarom via `style.cssText`. Dat was ook de oorzaak van voortgangsbalken die niet vulden en een knop die buiten beeld stond.
- **Venster sluiten:** Flits blijft standaard op de achtergrond draaien (tray). Een vergeten tray-proces hield de poort 53317 vast; `main.js` herkent dat nu en biedt aan het te herstarten.
- **Zwart scherm:** hardwareversnelling staat uit (`app.disableHardwareAcceleration()`), want dat gaf op sommige pc's een leeg venster.
- **Testserver van thinkbroadband:** niet te vaak gebruiken. Na veel verzoeken antwoordt die met `429 Too Many Requests`.
- **Snelheidsraadsel (niet opgelost):** op de ontwikkel-pc haalde één proces (Node of curl) hoogstens ongeveer 11 MB/s van de 2 GB-testfile, ook met 16 verbindingen. 16 losse processen haalden 30–40 MB/s. Hulpprocessen in Flits zelf hielpen niet, dus die proef is teruggedraaid. Misschien helpt meten op een andere server of pc.

## Ideeën voor later (nog niet gebouwd)

Klein: eigen downloadmap kiezen, melding als een download klaar is, pc wakker houden tijdens downloaden, meerdere links tegelijk plakken, downloadgeschiedenis (ook na herstart) met zoeken, hoe lang het geduurd heeft tonen, SHA-256 van een bestand controleren, automatisch hervatten bij opstarten, wachtrij (bijv. 2 tegelijk).
Groter: snelheidslimiet en planning, de downloader ook in de Android-app, versturen buiten je eigen netwerk (vraagt een tussenserver of Tailscale), bestanden tussen apparaten in stukken over meerdere verbindingen (proef gaf op één pc geen winst, niet bewaard).
Niet mogelijk: Steam-games (Steam levert niets via een gewone link), streaming (YouTube e.d.), links die inloggen vragen.

## Zo werkt het protocol tussen telefoon en pc

Zie `README.md` (UDP-broadcast op poort 53318, HTTPS op 53317, `POST /offer`, `PUT /upload/<token>/<id>`, `POST /cancel/...`). Beide apps spreken exact hetzelfde protocol; wijzig je er iets aan, pas dan `windows/src/core.js` én `android/app/src/main/java/nl/flits/app/Engine.kt` aan.
