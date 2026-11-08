# KI-Autopilot

Dein KI-Kanal auf Englisch, ohne dich vor der Kamera. Der Server läuft Tag und Nacht in der Cloud. Die App auf deinem Handy ist die Fernbedienung.

**Ein Knopf:** Auf der Startseite tippst du **„Neues Video – alles automatisch“**. Den Rest erledigt die App:
- Sie analysiert den Markt und wählt das stärkste Thema.
- Sie recherchiert, schreibt das Skript und prüft die Fakten.
- Sie spricht den Text ein, erstellt die KI-Szenen und schneidet das Video.

Danach bekommst du eine Push-Nachricht: **„Video fertig – bitte OK“**. Du schaust es an und tippst **OK**, in der App oder direkt in der Benachrichtigung. Dann geht es **sofort und gleichzeitig** auf Instagram, TikTok und YouTube. Was wo geklappt hat, zeigt dir die App je Plattform.

**So läuft ein Tag:**

1. **07:00** – Der Trend-Radar schaut, was gerade viel gesehen wird: YouTube-Aufrufe, Hacker News, Reddit und die KI-News der letzten 48 Stunden (Claude-Websuche). Daraus macht Claude acht Themen, sortiert nach Nachfrage. Du bekommst eine Push-Nachricht.
2. **Du tippst auf ein Thema** → „Video erstellen“. Ab hier läuft alles allein:
   - Claude recherchiert mit Quellen.
   - Claude schreibt das Skript mit Hook, 4–7 Szenen und einer Frage am Ende.
   - Ein zweites Modell prüft jede Aussage gegen die Quellen und korrigiert.
   - ElevenLabs spricht den Text ein, mit Zeitstempeln für jedes Wort.
   - fal.ai erzeugt für jede Szene ein KI-Video im Hochformat.
   - ffmpeg schneidet alles zusammen und brennt große Untertitel ein, das aktuelle Wort jeweils gelb.
3. **Das Video geht zum nächsten Sendeplatz online**, auf Instagram als Reel und auf YouTube als Short. Die Sendeplätze sind in US-Zeit (12:00 und 19:00 New York), weil dort dein Publikum sitzt. Push: „Online“.
4. **Danach läuft der Rest von selbst:**
   - Kommentare von Instagram und YouTube werden alle 15 Minuten eingesammelt. Auf Lob dankt die App automatisch, für Fragen schreibt sie Antwortentwürfe.
   - Die Zahlen (Aufrufe, Zuschauzeit, Shares) kommen nach 24 Stunden und nach 7 Tagen.
   - Sonntags gibt es ein Wochen-Review. Seine Erkenntnisse fließen in die nächsten Skripte ein.

**Vollautomatik** (Einstellungen → Betrieb): Dann wählt die App jeden Tag selbst das Top-Thema und produziert es. Du musst gar nichts mehr tippen.

**Selbstwartung:** Geht auf dem Server etwas schief, legt er auf GitHub ein Ticket mit Fehlerbericht an. Claude prüft die Tickets jede Nacht um 01:40, behebt den Fehler im Code, testet und lädt die Korrektur hoch. Um 03:30 spielt der Server die neue Version von selbst ein. In der App unter **Mehr → Wartung und Updates** siehst du die laufende Version, die neueste Version und alle offenen Tickets.

Auf der Startseite zeigt die Karte **„Gerade“** jederzeit, was passiert: welches Video entsteht, bei welchem Schritt, was als Nächstes online geht und die letzten Ereignisse.

---

## Was das kostet

| Posten | Kosten | Hinweis |
|---|---|---|
| Cloud-Server (Hetzner) | ca. 4–7 € / Monat | läuft rund um die Uhr |
| Claude | ca. 0,15–0,25 $ pro Video | Recherche mit Websuche, Skript, Faktencheck |
| KI-Szenen (fal.ai, Veo 3 Fast) | ca. 0,60 $ pro Szene | 7 Szenen à 6 s ≈ **4,20 $ pro Video** |
| Stimme (ElevenLabs Starter) | 5 $ / Monat | reicht für etwa 30 Videos |
| Trend-Radar | 0 € | YouTube-Schlüssel ist kostenlos |
| YouTube-Upload | 0 € | bis zu 6 Uploads pro Tag im kostenlosen Kontingent |

**Rechenbeispiel:**
- **1 Video pro Tag:** rund 130 $ im Monat für die Szenen, plus Server und Stimme.
- **3 Videos pro Woche:** rund 55 $ im Monat.

Das **Monatsbudget** (Standard 60 $) stoppt neue Videos, sobald es erreicht ist. Du kannst es in den Einstellungen ändern.

**Günstiger geht es so:**
- weniger Szenen einstellen,
- ein günstigeres Videomodell wählen,
- oder „Sparsam“ einschalten: animierte Grafik statt KI-Szenen, dann fast kostenlos.

---

## Einrichtung (einmalig, ca. 45 Minuten)

### Schritt 1 – Code auf GitHub (1 Minute, nur einmal)

Der Server holt sich den Code von GitHub und später auch jedes Update. Von hier aus konnte ich das Repository nicht anlegen. Das musst du einmal selbst machen:

1. [github.com/new](https://github.com/new) öffnen (angemeldet als `ahmedkay980-create`).
2. Name: **ki-autopilot**, Sichtbarkeit: **Public**. Alles andere leer lassen → **Create repository**.
3. Claude Bescheid sagen. Ich lade den Code dann hoch.

Im Code stehen keine Schlüssel oder Passwörter. Die liegen nur auf deinem Server.

### Schritt 2 – Schlüssel besorgen

| Dienst | Wo | Wofür |
|---|---|---|
| **Claude** | [platform.claude.com](https://platform.claude.com) → Billing (Guthaben aufladen) → API Keys | Recherche, Skript, Faktencheck |
| **fal.ai** | [fal.ai](https://fal.ai) → Dashboard → Billing → API Keys | KI-Videoszenen |
| **ElevenLabs** | [elevenlabs.io](https://elevenlabs.io) → Starter-Abo → Profil → API Keys | Stimme |
| **YouTube** (optional) | [console.cloud.google.com](https://console.cloud.google.com) → Projekt anlegen → „YouTube Data API v3“ aktivieren → Anmeldedaten → API-Schlüssel | echte Aufrufzahlen im Radar |

### Schritt 3 – Instagram-Konto für den Kanal

1. **Neues Instagram-Konto** für den englischen KI-Kanal anlegen. Dein persönliches Konto bleibt getrennt.
2. In Instagram → Einstellungen → Kontotyp → auf **Creator** umstellen.
3. Auf [developers.facebook.com](https://developers.facebook.com) → Meine Apps → **App erstellen** → Anwendungsfall „Instagram“ wählen.
4. Im App-Dashboard: Instagram → **API-Einrichtung mit Instagram-Login** → bei „Zugriffstokens generieren“ **Konto hinzufügen** → mit dem Kanal-Konto anmelden → Token kopieren.
   - Fragt Meta nach einer Tester-Rolle, dann:
     - unter App-Rollen → Rollen den Kanal als Instagram-Tester hinzufügen,
     - in Instagram unter Einstellungen → Apps und Websites → Tester-Einladungen annehmen.
5. Das Token trägst du später in der App ein (Schritt 5).

Die Meta-App kann im Entwicklungsmodus bleiben, solange nur dein eigenes Konto verbunden ist.

### Schritt 4 – Server starten (Hetzner)

1. Auf [hetzner.com/cloud](https://www.hetzner.com/cloud) registrieren.
2. Neues Projekt → **Server hinzufügen**:
   - **Standort:** Falkenstein oder Nürnberg
   - **Image:** Ubuntu 24.04
   - **Typ:** das kleinste Paket mit mindestens 2 vCPU und 4 GB RAM
   - **Netzwerk:** öffentliche IPv4 **an**
3. Ganz unten bei **Cloud config** den kompletten Inhalt von `deploy/hetzner-cloud-config.yaml` einfügen. **Nur die Passwort-Zeile ändern:** mindestens 12 Zeichen, nur Buchstaben und Zahlen.
4. **Erstellen**. Nach 5–10 Minuten ist alles installiert.
5. Die IP-Adresse des Servers aus der Hetzner-Übersicht nehmen und die Punkte durch Bindestriche ersetzen. Aus `5.75.123.45` wird:
   **https://5-75-123-45.sslip.io**

### Schritt 5 – App aufs Handy

1. Diese Adresse in **Chrome** auf dem Android-Handy öffnen → mit dem Passwort aus Schritt 4 anmelden.
2. **Als App installieren** (Knopf im Radar oder Chrome-Menü ⋮ → „App installieren“). Ab jetzt hat sie ein eigenes Symbol, läuft im Vollbild und kommt ohne Play Store aus. Sie aktualisiert sich selbst.
3. **Mehr → App und Push → Push aktivieren** → erlauben → **Test-Nachricht**.
4. **Mehr** → bei Claude, KI-Video, Stimme und Trend-Radar die Schlüssel eintragen → jeweils **Testen**.
5. **Mehr → Instagram** → Token einfügen → **Verbinden** → **Testen**.
6. **Radar → Neu analysieren.** Ein Thema antippen → das erste Video entsteht im **Trockenlauf**: Alles passiert echt, nur gepostet wird noch nicht. Im Studio siehst du jeden Schritt und am Ende das fertige Video.
7. Gefällt dir das Ergebnis: **Mehr → Betrieb → Trockenlauf aus** → Speichern. Ab jetzt postet die App wirklich.

### Schritt 6 – YouTube Shorts (10 Minuten)

1. [console.cloud.google.com](https://console.cloud.google.com) → dasselbe Projekt wie für den API-Schlüssel → „YouTube Data API v3“ ist schon aktiviert.
2. **Google Auth Platform / OAuth-Zustimmungsbildschirm:**
   - Typ **Extern**, App-Name „KI-Autopilot“, deine E-Mail eintragen.
   - Danach **„App veröffentlichen“** (Status „In Produktion“). Sonst läuft der Zugang nach 7 Tagen ab.
   - Eine Google-Prüfung brauchst du dafür nicht, es ist deine eigene App.
3. **Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID:**
   - Typ **Webanwendung**.
   - Bei „Autorisierte Weiterleitungs-URIs“ die Adresse aus der App eintragen (Mehr → YouTube Shorts → Kopieren), z. B. `https://5-75-123-45.sslip.io/oauth/youtube`.
4. Client-ID und Client-Geheimnis in der App eintragen → **Speichern** → **Mit YouTube verbinden**.
   - Beim Hinweis „Google hat diese App nicht überprüft“: **Erweitert → Weiter zu KI-Autopilot**.
   - Kanal wählen: am besten einen eigenen englischen KI-Kanal, nicht deinen bestehenden.
5. **Wichtig:** Google sperrt Uploads neuer API-Projekte zunächst auf „privat“. Erst nach der Prüfung durch YouTube sind sie öffentlich.
   - Den Antrag stellst du über das Formular „YouTube API Services – Audit and Quota Extension“.
   - Bis zur Freigabe zeigt die App das an. Öffentlich geht es dann über **Studio → Teilen → YouTube-App**.

### Schritt 6b – TikTok (10 Minuten)

1. Auf [developers.tiktok.com](https://developers.tiktok.com) mit deinem TikTok-Konto anmelden → **Manage apps → Connect an app**.
2. Produkte hinzufügen:
   - **Login Kit:** Als Redirect URI die Adresse aus der App eintragen (Mehr → TikTok → Kopieren), z. B. `https://5-75-123-45.sslip.io/oauth/tiktok`.
   - **Content Posting API:** Wenn du direkt posten willst, dort „Direct Post“ einschalten.
3. Scopes: `user.info.basic`, `video.upload`, `video.publish`.
4. Unter **Sandbox** dein TikTok-Konto als Testnutzer eintragen. So funktioniert alles für dich, ohne dass TikTok die App vorher prüft.
5. Client Key und Client Secret in der App eintragen → **Speichern** → **Mit TikTok verbinden** → **Testen**.
6. **Art wählen:**
   - **Ins TikTok-Postfach** (Standard): Das Video landet in deiner TikTok-App. Ein Tipp auf die Benachrichtigung veröffentlicht es.
   - **Direkt veröffentlichen:** Geht ohne Tipp online, aber erst nach der App-Prüfung durch TikTok (Antrag im Entwicklerportal). Vorher erlaubt TikTok Direkt-Posts nur privat und nur auf privaten Konten.

### Schritt 7 – Selbstwartung (5 Minuten)

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → **Generate new token**.
2. Repository access: **Only select repositories → ki-autopilot**. Permissions: **Issues → Read and write**. Erstellen und kopieren.
3. App → **Mehr → Wartung und Updates** → Token eintragen → **Speichern** → **Testen**.

Ab dann meldet der Server Fehler selbst. Claude kümmert sich jede Nacht darum.

**Erster Live-Test (empfohlen):** Die Anbindungen an Instagram, fal.ai und ElevenLabs sind nach deren Dokumentation gebaut und mit simulierten Antworten getestet. Gegen deine echten Konten liefen sie hier noch nie. Poste das erste Live-Video deshalb mit **Studio → Jetzt posten**, während du zuschaust. Läuft das einmal, läuft es auch automatisch.

---

## Gut zu wissen

- **Sicherheitsnetz Faktencheck:** Findet das Prüfmodell eine erfundene oder falsche Aussage, die es nicht selbst korrigieren kann, hält die App vor dem teuren Teil an. Du bekommst dann eine Push-Nachricht „Kurz prüfen“. Ein Tipp auf „Trotzdem freigeben“, und es geht weiter. Abschalten kannst du das unter Betrieb.
- **Kennzeichnung:** Jede Caption enthält „Visuals and voice are AI-generated.“ und nennt die Quellen. Meta verlangt die Kennzeichnung realistischer KI-Inhalte.
- **Originalität:** Instagram drückt gleichförmige Massenware. Die App wechselt deshalb sechs Formate (News in 60 s, Erklärt, KI-Werkzeug, Mythos vs. Fakt, Top 3, Was es für dich heißt) und lernt aus deinen Zahlen. Formate, die schlecht laufen, kommen seltener.
- **Prüfungen der Plattformen:** TikTok und YouTube schalten öffentliche Uploads neuer Apps erst nach ihrer Prüfung frei. Bis dahin landen TikTok-Videos im Postfach (ein Tipp in der TikTok-App) und YouTube-Uploads privat. Die Anträge stehen in Schritt 6 und 6b. Instagram postet sofort öffentlich.
- **Tickets sind öffentlich:** Das Repository ist öffentlich, also auch die Fehlertickets. Der Server entfernt Schlüssel und Token aus jedem Bericht.
- **Musik:** Es gibt keine Hintergrundmusik, denn lizenzierte Instagram-Musik geht über die Schnittstelle nicht. Die Stimme trägt das Video.
- **Updates:** Der Server holt sich jede Nacht um 03:30 die neueste Version von GitHub.
- **Fehler:** Ist ein Dienst kurz nicht erreichbar, versucht die App es bis zu dreimal selbst. Erst danach meldet sie sich.
- **Instagram-Zugang:** Er gilt 60 Tage und wird wöchentlich automatisch verlängert.

## Wenn etwas hakt

| Problem | Lösung |
|---|---|
| Adresse lädt nicht | 10 Minuten nach dem Erstellen warten. In Hetzner prüfen, ob die öffentliche IPv4 an ist. |
| „Claude lehnt den API-Schlüssel ab“ | Schlüssel neu kopieren, Guthaben in der Claude Console prüfen. |
| „fal.ai: …“ | Guthaben bei fal.ai aufladen. Prüfen, ob die Modell-ID unter KI-Video stimmt. |
| „Instagram: … (Code 190)“ | Token abgelaufen → in der Meta-App neu erzeugen → Mehr → Instagram → Neu verbinden. |
| „Instagram verarbeitet das Video nicht“ | Selten. Studio → Weitermachen. Bleibt es, im Protokoll nachsehen. |
| Keine Push-Nachrichten | Android-Einstellungen → Apps → Autopilot → Benachrichtigungen erlauben, dann Push neu aktivieren. |

## Für Technikfreunde

- **Laufzeit:** Node.js ab Version 20, keine Abhängigkeiten. ffmpeg für den Schnitt.
- **Tests:** `npm test` führt die Tests aus, darunter ein kompletter Produktionslauf mit echtem ffmpeg und simulierten Schnittstellen, Web-Push-Verschlüsselung und der Instagram-Ablauf.
- **Lokal starten:** `node server.js` → http://localhost:4747 (lokal ohne Passwort).
- **Aufbau:**

| Datei | Aufgabe |
|---|---|
| `src/engine.js` | Produktionskette und Aufgaben |
| `src/trends.js` | Radar |
| `src/agents.js` | Prompts |
| `src/voice.js` | Stimme |
| `src/visuals.js` | KI-Szenen |
| `src/render.js` | Schnitt und Untertitel |
| `src/instagram.js` | Instagram |
| `src/youtube.js` | YouTube Shorts |
| `src/tiktok.js` | TikTok |
| `src/github.js` | Selbstwartung |
| `src/webpush.js` | Push |
| `public/` | die App |

- **Daten:** liegen auf dem Server in `/opt/ki-autopilot/data` (Einstellungen, Datenbank, Videos, Tagessicherungen).
- **Schriften:** Die Untertitel nutzen die Schrift Inter (SIL Open Font License, rsms.me/inter).
