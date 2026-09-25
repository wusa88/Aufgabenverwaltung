# Aufgaben

Schnell aufschreiben, nichts vergessen. Eine schlanke Aufgabenliste fürs Handy
(und den PC): Text tippen, Kategorie antippen, fertig. Erledigtes bleibt
erhalten und ist jederzeit nachzulesen.

* **Eingabe:** Feld oben. Beim Tippen werden die Kategorie-Chips darunter zu
  Speicherzielen: ein Tipp auf „Schule Nord“ speichert direkt dort. **↵**
  speichert in die gerade gewählte Kategorie (bei „Alle“: ohne Kategorie).
* **Übersicht:** „Alle“ zeigt alles nach Kategorie gruppiert, ein Chip zeigt
  nur diese Kategorie. Wichtige (★) stehen oben, sonst die neueste zuerst.
* **Erledigt:** Kreis antippen. Nichts wird gelöscht, der Reiter „Erledigt“
  zeigt alles nach Tagen, die Lupe sucht in offenen *und* erledigten Aufgaben.
* **Ohne Netz:** Eingaben und Häkchen werden auf dem Handy zwischengespeichert
  und automatisch nachgeschickt, sobald der Server wieder erreichbar ist.
* **Kürzel:** `!` am Anfang = wichtig, `#name` = Kategorie
  (`#schule Beamer prüfen` → „Schule Nord“; eindeutiger Anfang reicht).

Nur Python-Standardbibliothek, keine externen Dienste, kein CDN. Die Daten
liegen in einer lesbaren JSON-Datei im Docker-Volume.

## Starten

### Portainer (Stack aus dem Git-Repository)

1. Stack anlegen, Repository angeben, Compose-Pfad `docker-compose.yml`.
2. Unter **Environment variables** mindestens `APP_PASSWORD` setzen
   (Vorlage und weitere Werte: `.env.example`).
3. Deploy. Änderungen später über **Pull and redeploy** (die Compose-Datei hat
   `pull_policy: build`, dadurch wird neu gebaut).

### docker compose

```bash
cp .env.example .env    # Passwort eintragen
docker compose up -d --build
```

Danach läuft die App auf `http://<docker-host>:8092`.

### Ohne Docker (zum Ausprobieren)

```bash
APP_PASSWORD=test PORT=8092 python3 server.py
```

## HTTPS – nötig für „App installieren“

Android bietet das Installieren, die Kurzbefehle am App-Symbol und den Eintrag
im „Teilen“-Menü **nur über HTTPS** an. Über `http://192.168.…` funktioniert
die App im Browser trotzdem, nur eben als normale Webseite.

Am einfachsten wie bei Vikunja und TriliumNext: einen Eintrag im
Reverse-Proxy (z. B. Nginx Proxy Manager) auf `http://<docker-host>:8092` mit
Let's-Encrypt-Zertifikat. Die App setzt ihr Login-Cookie dann automatisch als
`Secure`.

Keine zusätzliche Proxy-Anmeldung (Authelia, Basic Auth o. ä.) davorschalten:
installierte Web-Apps, „Teilen“ und die Kurzbefehle kommen damit schlecht klar.
Dafür gibt es das eingebaute Passwort – jedes Gerät meldet sich einmal an und
bleibt angemeldet.

## Aufs Handy bringen

1. Die Adresse in **Chrome** öffnen und anmelden.
2. **„App installieren“** antippen (oder Menü ⋮ → „Zum Startbildschirm hinzufügen“).
   Danach startet „Aufgaben“ wie eine normale App – ohne Adressleiste, sofort,
   auch ohne Netz.
3. **Schnellzugriff:** App-Symbol lange drücken → „Neue Aufgabe“ oder eine der
   ersten drei Kategorien. Den Eintrag kann man auf den Startbildschirm ziehen
   – dann ist es ein Tipp bis zum offenen Eingabefeld. Welche drei Kategorien
   erscheinen, bestimmt die Reihenfolge in den Einstellungen (Regler-Symbol
   oben rechts; Android übernimmt Änderungen mit etwas Verzögerung).
4. **Teilen:** In jeder App (Browser, Mail, Messenger) „Teilen“ → „Aufgaben“.
   Der Text steht dann im Eingabefeld, nur noch die Kategorie antippen.

## Noch schneller: Kachel oder Widget ohne App-Start (optional)

Mit der freien Android-App **HTTP Shortcuts** lässt sich eine Aufgabe über eine
Kachel in den Schnelleinstellungen (Wischen von oben) oder ein Widget anlegen,
ohne die App zu öffnen:

1. In der `.env` bzw. in Portainer `API_TOKEN` auf einen zufälligen Wert setzen
   (`openssl rand -hex 24`) und neu deployen.
2. In HTTP Shortcuts eine Variable vom Typ **Texteingabe** anlegen, z. B. `aufgabe`.
3. Neuer Shortcut:
   * Methode `POST`, URL `https://<deine-adresse>/api/tasks`
   * Header `Authorization: Bearer <API_TOKEN>`
   * Request-Body als eigener Text, Content-Type `text/plain`, Inhalt: nur
     die Variable `aufgabe` (über das Variablen-Symbol einfügen)
4. Shortcut als Kachel oder Widget ablegen.

`#name` und `!` funktionieren auch hier. Wer lieber eine Auswahl will: Body als
JSON (`application/json`) mit
`{"text": <Variable aufgabe>, "cat": "Schule Nord"}` – `cat` darf der Name oder
die Id einer Kategorie sein.

## Daten und Sicherung

Im Volume `aufgaben-daten` (im Container `/data`):

| Datei | Inhalt |
|---|---|
| `aufgaben.json` | alle Kategorien und Aufgaben, eine Zeile pro Eintrag |
| `aufgaben.json.bak` | Stand vor der letzten Änderung |
| `sicherung/aufgaben-JJJJ-MM-TT.json` | ein Stand pro Tag, die letzten 30 |
| `.secret` | Schlüssel für das Login-Cookie |

In den Einstellungen → „Alles exportieren“ gibt es dieselbe Datei als Download.

Kategorie löschen entfernt keine Aufgaben: sie stehen danach unter „Ohne
Kategorie“ – auch die erledigten.

## Einstellungen (Umgebungsvariablen)

| Variable | Bedeutung |
|---|---|
| `APP_PASSWORD` | Passwort für die Anmeldung (Pflicht im Compose-Stack) |
| `APP_PORT` | Port auf dem Host, Standard `8092` |
| `API_TOKEN` | optional, für die Schnelleingabe per HTTP |
| `SECRET_KEY` | optional, sonst wird einer im Volume erzeugt |
| `TZ` | Zeitzone, Standard `Europe/Berlin` |
