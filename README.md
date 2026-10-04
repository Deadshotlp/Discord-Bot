# Discord Bot

Modularer Discord-Bot für Community- und Gameserver-Betrieb. Die Konfiguration
läuft vollständig über ein Web-Dashboard – in Discord gibt es kein Setup-Panel
mehr, sondern nur noch Befehle für den täglichen Betrieb.

## Überblick

| Bereich | Was der Bot macht |
| --- | --- |
| **Server-Monitoring** | Beliebig viele Game- und Webserver, feine Abtastraten, Verlaufsdaten, Live-Panel in Discord |
| **Support** | Ticket-System und Sprach-Support mit Fallverwaltung, Departments, Transkripten |
| **Team-Abmeldungen** | Abwesenheiten pro Department erfassen, ankündigen und als Übersicht pflegen |
| **Teamliste** | Wer ist im Team? Nach Departments gruppiert, mit Leitung und aktuellen Abmeldungen |
| **Steam-Verknüpfung** | SteamID ↔ Discord, daraus Spielzeiterfassung pro Server |
| **Meetings** | Wiederkehrende Termine mit Agenda, An-/Abmeldung, Anwesenheitsauswertung |
| **Wochenberichte** | Abgaben je Department, terminierte Veröffentlichung |
| **Updates & Changelogs** | GitHub-Releases beobachten, manuelle Changelogs posten |
| **Content-Creator** | YouTube- und Twitch-Benachrichtigungen |
| **Reaction-Roles / Verify** | Rollenvergabe per Button |

## Schnellstart

1. `.env` aus `.env.example` erstellen und `DISCORD_TOKEN` eintragen.
2. Für das Dashboard zusätzlich `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` und
   `WEB_BASE_URL` setzen. Im Discord Developer Portal unter **OAuth2 → Redirects**
   `<WEB_BASE_URL>/api/auth/callback` eintragen.
3. Abhängigkeiten installieren und starten:

```bash
npm install
```

```bash
npm run start
```

4. Dashboard öffnen (`WEB_BASE_URL`) oder in Discord `/dashboard` ausführen.

Es wird **kein privilegiertes Intent** benötigt. Mitglieder lädt der Bot bei
Bedarf einzeln per REST nach. Einzige Ausnahme ist die [Teamliste](#teamliste) –
sie braucht die vollständige Mitgliederliste und damit das Server-Members-Intent.

## Architektur

```text
src/
  config/     Env-Parsing
  core/       Logger, SQLite, Einstellungen, Scheduler, Berechtigungen, Audit
  events/     Discord-Event-Registrierung und Dispatch an die Module
  modules/    Ein Ordner pro Feature mit index.js, commands/, services/, handlers/
  web/        HTTP-Server, Discord-OAuth, REST-API
web/public/   Dashboard-Oberfläche (reines ES-Modul-Frontend, kein Build-Schritt)
addons/       Spielserver-Addons (Garry's Mod Bridge)
```

Jedes Modul exportiert `name`, `label`, `description`, `defaultEnabled`,
`defaultConfig`, `commands` und `events` und wird in `src/modules/index.js`
registriert. Module lassen sich pro Server einzeln aktivieren.

Zustand liegt in `data/`:

- `bot.db` – Modul-Einstellungen, Monitoring, Abmeldungen, Steam-Links, Sessions, Audit
- `support-tickets.db`, `support-cases.db`, `meetings.db`, `weekly-reports.db` – Fachdaten

Über `DATA_DIR` lässt sich ein anderes Verzeichnis setzen, z. B. ein
persistentes Volume. Eine vorhandene `data/module-config.json` aus der
Vorgängerversion wird beim ersten Start automatisch übernommen.

## Zeitzone

Der Bot rechnet durchgehend mit lokaler Zeit: Tagesgrenzen von Abmeldungen,
Meeting-Termine, Veröffentlichung der Wochenberichte, Tagesprofile im
Monitoring, Zeitstempel in Logs und Transkripten. Vorgabe ist
`Europe/Berlin`; abweichend über einen IANA-Namen einstellbar:

```dotenv
BOT_TIMEZONE=Europe/Berlin
```

Ein vom Container gesetztes `TZ=UTC` (Pterodactyl) wird ignoriert. Ein fester
Versatz wie `+01:00` wird absichtlich nicht unterstützt: `Europe/Berlin`
deckt MEZ (+1) und MESZ (+2) samt Umstellungsterminen ab. Details siehe
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Web-Dashboard

Die Anmeldung erfolgt per Discord-OAuth. Was sichtbar ist, ergibt sich aus den
echten Rollen auf dem Server:

| Stufe | Wer | Rechte |
| --- | --- | --- |
| **Admin** | Administrator / Server verwalten | alles, inkl. Module und Departments |
| **Leitung** | Mitglied einer Leitungs-Rolle eines Departments | Tickets, Team-Statistiken, Meetings, Freigaben |
| **Team** | Mitglied einer Department-Rolle | Tickets und Fälle des eigenen Bereichs |
| **Mitglied** | sonstige Servermitglieder | eigene Abmeldungen, Meetings, Steam, Serverstatus |

Seiten: Übersicht, Server-Monitoring, Tickets, Teamliste, Team-Statistiken,
Abmeldungen, Meetings, Steam & Spielzeit, Einstellungen, Protokoll.

Auf der Ticket-Seite lässt sich jedes Ticket öffnen: Der Nachrichtenverlauf des
Discord-Channels wird angezeigt und alle 15 Sekunden nachgeladen. Antworten
gehen als Bot-Embed mit dem Namen des Teammitglieds in den Ticket-Channel;
Schließen und Department-Wechsel verhalten sich wie die Buttons in Discord.

Das Frontend besteht aus reinen ES-Modulen ohne Build-Schritt – es gibt nichts zu
kompilieren, `npm install` genügt. Hinter einem Reverse Proxy sollte
`WEB_BASE_URL` auf die externe HTTPS-Adresse zeigen; Session-Cookies werden dann
automatisch als `Secure` gesetzt.

## Server-Monitoring

Unterstützte Servertypen:

| Typ | Protokoll | Spielerliste |
| --- | --- | --- |
| Source / Garry's Mod | A2S über UDP | Namen, mit Addon auch SteamIDs |
| Minecraft | Server List Ping | Auszug aus dem Sample |
| FiveM / alt:V | HTTP (`dynamic.json`, `players.json`) | inkl. SteamID |
| HTTP / Website | HTTP-Statuscode | – |
| TCP-Port | Verbindungsaufbau | – |

- Server werden im Dashboard oder mit `/server add` angelegt und **sofort ohne
  Neustart** überwacht.
- Abtastrate ist pro Server einstellbar (15–3600 s, Standard 30 s).
- Rohdaten bleiben 14 Tage, Stundenwerte 180 Tage, Tageswerte dauerhaft.
- Erfasst werden Online-Status, Spielerzahl, Slots, Map, Bots, Ping und Version.
- Ausgewertet werden Ø/Peak je Zeitraum, Auslastung, Uptime, Trend gegenüber dem
  Vortag, Primetime, Tages- und Wochentagsprofil, Map-Verteilung sowie
  Einzelspieler pro Woche/Monat.
- Bei Online-/Offline-Wechsel kann der Bot eine Rolle pingen.

Befehle: `/server add|list|edit|remove|status|vergleich|top`

## Team-Abmeldungen

- `/abmeldung melden von:24.12.2026 bis:02.01.2027 art:Urlaub` – Datumsangaben
  auch im deutschen Format.
- Zuordnung zu Departments erfolgt automatisch über die Rollen des Mitglieds
  oder wird explizit gewählt.
- **Abmelde-Panel:** Ist unter Einstellungen ein *Abmelde-Panel-Channel* gesetzt,
  stellt der Bot dort eine Nachricht mit den Buttons **Abmelden** und
  **Meine Abmeldungen** bereit – Art auswählen, Zeitraum im Formular eintragen,
  fertig. Kein Befehl nötig.
- Ankündigung im Department-Channel (Fallback: allgemeiner Channel), dazu eine
  laufend aktualisierte Übersicht „wer ist heute weg / wer ist geplant weg“.
- Optional Freigabepflicht durch die Bereichsleitung.
- Im Dashboard gibt es zusätzlich eine Zeitleiste pro Department.

Befehle: `/abmeldung melden|meine|zurueckziehen|liste|freigeben`

## Teamliste

Zeigt, wer aktuell im Team ist – gruppiert nach Departments, mit 👑 für die
Bereichsleitung und einem Vermerk, wer heute abgemeldet ist.

- Die Zuordnung ergibt sich aus den Rollen der Departments: Bereichsrolle
  **oder** Leitungsrolle. Wer nur die Leitungsrolle trägt, steht trotzdem im
  Bereich.
- Innerhalb eines Departments steht die Leitung oben, danach wird alphabetisch
  sortiert. Bots und Mitglieder ohne Department-Rolle bleiben außen vor.
- Abmeldungen kommen aus dem Modul Team-Abmeldungen; angezeigt wird nur, wer
  **heute** abwesend ist.
- Im Dashboard gibt es dieselbe Liste unter **Teamliste**, dort mit Avataren.

Befehl: `/team liste [bereich] [oeffentlich]` – öffentlich posten dürfen
Bereichsleitung und Admins, alle anderen sehen die Liste nur selbst.

### Dauerhafte Liste im Channel

Ist unter **Einstellungen → Teamliste** ein *Teamlisten-Channel* gesetzt, hält
der Bot dort eine eigene Nachricht aktuell – ohne den Hinweis „X verwendet
/team liste" darüber. Sie wird sofort neu gezeichnet, wenn jemand eine
Department-Rolle bekommt oder verliert, dem Server beitritt oder ihn verlässt.
Zusätzlich läuft eine Auffrischung im eingestellten Takt (Standard 30 Minuten),
damit auch beginnende und endende Abmeldungen erscheinen.

Dafür ist das Server-Members-Intent nötig (siehe unten): ohne es bekommt der Bot
die Rollenänderungen gar nicht mit.

> **Voraussetzung:** Das Auflisten aller Mitglieder einer Rolle geht bei Discord
> nur mit dem privilegierten **Server Members Intent**. Dafür im Developer Portal
> unter **Bot → Privileged Gateway Intents** den Schalter setzen und in der `.env`
> `GUILD_MEMBERS_INTENT=true` eintragen, dann den Bot neu starten. Ohne beides
> startet der Bot zwar normal, `/team liste` meldet aber, dass die Liste fehlt.

## Steam-Verknüpfung und Spielzeit

- Im Dashboard per **Steam-Login** (OpenID, kein API-Key nötig).
- Oder im Spiel: `/steam verknuepfen` in Discord → Code im Spielchat eingeben
  (`!discord ABC123`).
- Oder manuell durch das Team: `/steam setzen @mitglied <SteamID>`.

Für SteamID-genaue Spielzeit auf Source-Servern wird das Addon
[`addons/gmod-bot-bridge`](addons/gmod-bot-bridge/README.md) benötigt – A2S
liefert nur Spielernamen. FiveM-Server brauchen kein Addon.

Befehle: `/steam verknuepfen|status|entfernen|setzen|spielzeit|wer`

## Support

- Ticket-Panel, Department-Auswahl, Eskalation und automatische Transkripte.
- Sprach-Support: Beim Join in den Warteraum entsteht ein Fall im
  Verwaltungschannel, ein Supporter claimt ihn, beide werden in einen freien
  Talk-Channel verschoben.
- Jede Aktion (Ticket geschlossen, Fall übernommen, eskaliert) wird für die
  Team-Statistik erfasst.

Befehle: `/support-department`, `/support-ticket-panel`

### Sprach-Transkripte (optional)

Support-Gespräche werden lokal via `whisper.cpp` transkribiert – kein
Cloud-Dienst, keine laufenden Kosten. Die Aufnahme startet **erst, wenn alle
Teilnehmer zugestimmt haben**; Audiodaten werden nach der Transkription gelöscht.

> **Rechtlicher Hinweis:** Das Aufzeichnen von Gesprächen ohne Einwilligung aller
> Beteiligten ist in Deutschland strafbar (§ 201 StGB). Die Zustimmungsabfrage
> darf nicht umgangen werden.

Einrichtung (auch im Wings-/Pterodactyl-Container, ohne Root):

1. Linux-Release von `whisper.cpp` (`whisper-bin-ubuntu-x64`) als **kompletten
   Ordner** hochladen – `whisper-cli` ist dynamisch gelinkt und braucht die
   `.so`-Dateien im selben Ordner. `chmod +x whisper-cli`.
2. Modell herunterladen, z. B. `ggml-medium-q5_0.bin` (gute Deutsch-Qualität,
   ~1,5 GB RAM) oder `ggml-small-q5_1.bin` (~600 MB).
3. In der `.env`: `WHISPER_BINARY_PATH`, `WHISPER_MODEL_PATH`, optional
   `WHISPER_LIB_DIR`, `WHISPER_THREADS`, `WHISPER_LANGUAGE`.

Vorab testen:

```bash
cd /home/container/whisper-bin-ubuntu-x64 && LD_LIBRARY_PATH=. ./whisper-cli --help
```

## Meetings

- Beliebig viele Meetings pro Server, konfiguriert im Dashboard.
- Ankündigung zur Vorlaufzeit mit Agenda und Buttons „Anmelden“ / „Abmelden“ /
  „Thema einreichen“.
- 5 Minuten nach Beginn wertet der Bot die Anwesenheit aus:
  ✅ anwesend (im Voice) · 📝 entschuldigt (abgemeldet) · ❌ unentschuldigt.
- Themen sind einmalig oder als 🔁 Dauerthema markierbar.

Befehle: `/meeting anmelden|abmelden|thema|status`

## Wochenberichte

- Abgabe mit `/wochenbericht abgeben` (Modal, Markdown, bis 3900 Zeichen).
- Veröffentlichung zum konfigurierten Termin: Kopfzeile mit Kalenderwoche plus
  ein Embed je Department; fehlende Abgaben werden markiert.
- Optionale Erinnerung an die Leitungs-Rollen der Departments ohne Abgabe. Der
  Erinnerungs-Channel lässt sich getrennt vom Veröffentlichungs-Channel setzen;
  bleibt er leer, wird der Veröffentlichungs-Channel genutzt.
- Verpasste Termine (Bot offline) werden beim nächsten Start nachgeholt.

## Updates & Content-Creator

- `/updates-repo add owner/repo` beobachtet GitHub-Releases; beim Hinzufügen wird
  der aktuelle Stand als Basislinie gespeichert.
- Optional mit Branch (`/updates-repo add … branch:dev` – auch für ein schon
  beobachtetes Repo – oder `/updates-repo branch`): Releases werden weiter gepostet, neue Commits auf dem
  Branch zusätzlich – mehrere in einem Post. Ohne Branch: neue Releases, bei Repos
  ohne Releases Commits auf dem Haupt-Branch. Forks werden dann mit diesem Branch
  des Originals verglichen.
- `/updates-repo fork-add repo:owner/repo fork:benutzer [branch]` hinterlegt
  zusätzlich einen bestimmten Fork. Gepostet werden nur Commits, die es im
  Original nicht gibt – zieht ein Fork bloß den Stand des Originals nach, bleibt
  es still. Ohne `branch` gilt der Haupt-Branch des Forks; beim Tippen schlägt
  der Bot die Branches des gewählten Forks vor (Haupt-Branch zuerst). Entfernen mit
  `/updates-repo fork-remove`; alles auch im Dashboard unter *Einstellungen →
  GitHub-Updates*.
- Wird ein beobachtetes Repo auf GitHub umbenannt, übernimmt der Bot den neuen
  Namen beim nächsten Abruf selbst.
- `/changelog` öffnet ein Formular für manuelle Ankündigungen.
- Content-Creator-Kanäle werden im Dashboard gepflegt; Profile werden gegen die
  YouTube-/Twitch-API aufgelöst. Dafür sind `YOUTUBE_API_KEY` bzw.
  `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` nötig.

## API für Spielserver

Für Server-Addons gibt es eine Token-authentifizierte Schnittstelle. Der Token
wird im Dashboard je Server erzeugt und im Header `x-ingest-token` gesendet.

| Endpunkt | Zweck |
| --- | --- |
| `POST /api/ingest/players` | Spielerliste mit SteamID und Spielzeit melden |
| `POST /api/ingest/link` | Verknüpfungscode eines Spielers einlösen |
| `GET /api/ingest/ping` | Verbindung testen |

## Entwicklung

```bash
npm run dev
```

- `npm run lint` – ESLint über Bot und Dashboard.
- `npm test` – Testsuite (Node-Test-Runner).
- Bei jedem Push läuft die CI mit Lint und Tests.

Neues Modul: Ordner unter `src/modules/<name>` anlegen, `commands`/`events`
exportieren, in `src/modules/index.js` registrieren. Konfigurationsfelder für das
Dashboard werden in `web/public/views/settings.js` unter `MODULE_FIELDS`
beschrieben.
