# KI-Autopilot

Eine Android-App für einen gesichtslosen, englischsprachigen KI- und Technik-Kanal. Kein Server, kein Computer – alles läuft auf deinem Handy.

**[⬇ App herunterladen (APK)](https://github.com/ahmedkay980-create/ki-autopilot/releases/latest/download/KI-Autopilot.apk)**

## So funktioniert's

1. Du tippst auf **„Neues Video erstellen“**.
2. Die App macht den Rest allein:
   - analysiert den Markt (YouTube, Hacker News, Reddit, aktuelle News),
   - nimmt das stärkste Thema und recherchiert es mit Websuche,
   - schreibt das Skript und prüft jede Aussage gegen die Quellen,
   - vertont, erzeugt KI-Videoszenen, schneidet und setzt Untertitel.
3. Nach 8–15 Minuten kommt die Nachricht **„Video fertig“**. Du tippst **OK**, und es geht gleichzeitig auf Instagram, TikTok und YouTube.

Die App darf dabei geschlossen sein. Wer gar nichts tippen will: unter **Mehr → Autopilot** „Jeden Tag automatisch ein Video“ und „Ohne OK sofort hochladen“ einschalten.

## Was das kostet

| Posten | Kosten |
|---|---|
| KI-Szenen (fal.ai, Veo 3.1 Fast, 0,10 $ pro Sekunde) | ca. 5–6 $ pro Video |
| Claude (Recherche, Skript, Faktencheck) | ca. 0,20–0,40 $ pro Video |
| Stimme (ElevenLabs Starter) | 5 $ im Monat |
| Schnitt, Untertitel, Marktanalyse | wenige Cent |

Das **Monatsbudget** (Standard 60 $) verhindert, dass mehr ausgegeben wird. Du stellst es unter Mehr → Autopilot ein.

## Einrichten (einmalig)

### 1. App installieren – 2 Minuten

1. Den Link oben auf dem Handy öffnen.
2. Die APK öffnen und Installation aus dieser Quelle erlauben.
3. Die App öffnen, Benachrichtigungen erlauben, auf der Startseite **„Im Hintergrund erlauben“** tippen.

### 2. Drei Schlüssel eintragen – 10 Minuten

In der App unter **Mehr → Schlüssel** eintragen, jeweils mit **Testen** prüfen:

| Dienst | Wo | Wofür |
|---|---|---|
| **Claude** | [platform.claude.com](https://platform.claude.com) → Billing (Guthaben laden) → API Keys | Denken und Schreiben |
| **fal.ai** | [fal.ai](https://fal.ai) → Billing (Guthaben laden) → API Keys | KI-Szenen, Schnitt, Untertitel |
| **ElevenLabs** | [elevenlabs.io](https://elevenlabs.io) → Starter-Abo → API Keys | Stimme |

Ab jetzt funktioniert der Knopf. Das fertige Video kannst du in der App ansehen.

### 3. Plattformen verbinden

**Instagram – 10 Minuten**

1. Ein eigenes Instagram-Konto für den Kanal anlegen und unter Einstellungen → Kontotyp auf **Creator** stellen.
2. [developers.facebook.com](https://developers.facebook.com) → App erstellen → Anwendungsfall **Instagram**.
3. **API-Einrichtung mit Instagram-Login** → Konto hinzufügen → **Token generieren** → kopieren.
4. In der App: **Mehr → Plattformen → Instagram** → Token einfügen → **Verbinden**. Die App verlängert den Zugang danach selbst.

**Einmalig für YouTube und TikTok: GitHub Pages einschalten – 1 Minute**

[Repository-Einstellungen → Pages](https://github.com/ahmedkay980-create/ki-autopilot/settings/pages) → Branch **main**, Ordner **/docs** → **Save**.

Darüber kehrt die Anmeldung von Google und TikTok in die App zurück. Die Weiterleitungs-URI für die beiden Konsolen kopierst du in der App unter **Mehr → Plattformen**.

**YouTube – 10 Minuten**

1. [console.cloud.google.com](https://console.cloud.google.com) → neues Projekt → **YouTube Data API v3** aktivieren.
2. Den **OAuth-Zustimmungsbildschirm** einrichten:
   - Typ **Extern**.
   - Danach **„App veröffentlichen“**. Sonst läuft der Zugang nach 7 Tagen ab.
3. Unter **Anmeldedaten** eine OAuth-Client-ID erstellen:
   - Typ **Webanwendung**.
   - Die Weiterleitungs-URI aus der App eintragen.
4. In der App Client-ID und Geheimnis eintragen → **Speichern** → **Mit Google verbinden**.
   - Bei „App nicht überprüft“: **Erweitert → Weiter**.

**TikTok – 10 Minuten**

1. [developers.tiktok.com](https://developers.tiktok.com) → App anlegen.
2. Die Produkte **Login Kit** und **Content Posting API** hinzufügen.
3. Die Links aus der App eintragen: Weiterleitungs-URI, Datenschutz und Nutzungsbedingungen.
4. Unter **Sandbox** dein TikTok-Konto als Testnutzer eintragen.
5. In der App Client Key und Secret eintragen → **Speichern** → **Mit TikTok verbinden**.

### 4. Optional: Selbstwartung – 3 Minuten

1. GitHub → Settings → Developer settings → **Fine-grained token** erstellen:
   - nur für **ki-autopilot**,
   - Recht **Issues: Read and write**.
2. In der App unter **Mehr → Wartung** eintragen.

Technische Fehler meldet die App dann selbst. Claude behebt sie nachts, GitHub baut automatisch eine neue Version, und die App sagt dir Bescheid, wenn ein Update da ist.

## Ehrlich gesagt: Grenzen der Plattformen

- **Instagram** veröffentlicht sofort öffentlich.
- **YouTube:** Neue API-Projekte laden nur privat hoch, bis YouTube das Projekt geprüft hat. Den Antrag stellst du über das Formular „YouTube API Services – Audit and Quota Extension“. Bis dahin zeigt die App einen Hinweis.
- **TikTok:** Ungeprüfte Apps dürfen nur privat posten. Deshalb legt die App das Video standardmäßig **in dein TikTok-Postfach**; ein Tipp in TikTok veröffentlicht es. Nach der Prüfung durch TikTok stellst du auf „Direkt veröffentlichen“ um.
- **Kennzeichnung:** Jede Beschreibung enthält „Visuals and voice are AI-generated.“. TikTok und YouTube bekommen zusätzlich das offizielle KI-Kennzeichen.
- **Faktencheck:** Findet er eine Aussage, die er nicht selbst korrigieren kann, hält die App vor dem teuren Teil an und fragt dich.

## Wenn etwas hakt

| Meldung | Lösung |
|---|---|
| „Es fehlen noch Schlüssel“ | Mehr → Schlüssel |
| „Claude lehnt den API-Schlüssel ab“ / „Guthaben aufgebraucht“ | Schlüssel neu kopieren, Guthaben aufladen |
| „fal.ai: Schlüssel abgelehnt oder kein Guthaben“ | Guthaben bei fal.ai aufladen |
| „Einmalig nötig: GitHub Pages einschalten“ | siehe Schritt 3 |
| „YouTube-Zugang abgelaufen“ | Google-App auf „In Produktion“ stellen, neu verbinden |
| „Instagram: … (Code 190)“ | neues Token erzeugen und einfügen |
| Video bleibt „angehalten“ | **Weiter** tippen – fertige Schritte bleiben erhalten, es kostet nichts doppelt |

## Für Technikfreunde

- **`android/`** – die App: Kotlin ohne Fremdbibliotheken, Oberfläche als WebView aus `assets/www`.
  - `Engine.kt` – Produktionskette
  - `Trends.kt` – Marktanalyse
  - `Agents.kt` / `Claude.kt` – Redaktion
  - `Voice.kt` – Stimme
  - `Fal.kt` – KI-Szenen, Schnitt und Untertitel in der Cloud
  - `Platforms.kt` – Instagram, YouTube, TikTok
  - `PipelineService.kt` / `JobWorker.kt` – Arbeit im Hintergrund
- **Build:** Jeder Push auf `main` baut die APK über GitHub Actions. Ein Android-Emulator testet sie (Start, Marktanalyse, Anmelde-Rücksprung, Einstellungen), danach erscheint sie als Release.
- **Signierschlüssel:** liegt in `android/keystore/`, damit Updates sich über die alte Version installieren lassen.
- **`docs/`** – GitHub-Pages-Seiten: Anmelde-Weiterleitung, Datenschutz, Nutzungsbedingungen.
- **`src/`, `public/`** – die frühere Server-Variante (Node.js). Wird nicht mehr gebraucht, bleibt aber getestet (`npm test`).
