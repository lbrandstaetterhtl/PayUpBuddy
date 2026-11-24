# PayUpBuddy

Rechnung fotografieren, Beträge Freunden zuordnen, Fälligkeitsdatum setzen – fertig.
PayUpBuddy behält im Blick, wer wem wie viel schuldet.

## Funktionen

- **Rechnung hochladen**: Foto auswählen (am Handy direkt mit der Kamera). Die Beträge werden automatisch
  ausgelesen (OCR, läuft lokal auf dem Server, kein externer Dienst).
- **Zuordnen**: Jeden erkannten Posten einer oder mehreren Personen zuweisen (oder „Alle an …“), Datum „Zahlen bis“ wählen, speichern.
  Teilen sich mehrere Personen einen Posten, wird er gleichmäßig aufgeteilt (übrige Cents bekommen die Ersten).
  Wer die Rechnung hochlädt, hat sie bezahlt; Posten, die er/sie sich selbst zuordnet, sind der eigene Anteil.
- **Übersicht**: Was du schuldest, was dir geschuldet wird, pro Person saldiert, Überfälliges in Rot.
- **Bezahlt markieren**: Nur wer das Geld bekommt, bestätigt den Erhalt (einzeln oder „Alles von … erhalten“).
- **Benutzer**: Keine Registrierung. Nur Admins legen Benutzer an und setzen Passwörter zurück.
  Jeder kann sein Passwort unter „Konto“ ändern.

## Starten

### Mit Docker

```bash
docker compose up -d --build
```

Dann <http://localhost:3000> öffnen. Beim ersten Start wird der Benutzer `admin` angelegt;
das Passwort steht im Log (`docker compose logs`), außer es wurde per `ADMIN_PASSWORD` gesetzt.
Daten (SQLite-Datenbank und Bilder) liegen im Docker-Volume `payupbuddy-data`.

### Ohne Docker (Node.js ≥ 22.13)

```bash
npm install
npm start
```

| Variable         | Standard | Bedeutung                                   |
|------------------|----------|---------------------------------------------|
| `PORT`           | `3000`   | HTTP-Port                                   |
| `DATA_DIR`       | `./data` | Ordner für Datenbank und Bilder             |
| `ADMIN_PASSWORD` | zufällig | Passwort des ersten Admins (nur beim ersten Start) |

Für den Betrieb im Internet die App hinter einen Reverse-Proxy mit HTTPS stellen (z. B. Caddy oder Traefik).
Das Session-Cookie wird dann automatisch als `Secure` gesetzt.

## Entwicklung

```bash
npm run dev    # Neustart bei Änderungen
npm test
```

Aufbau:

- `src/app.js`: Routen (Express)
- `src/views.js`: HTML-Seiten (serverseitig gerendert, ohne Framework)
- `src/receipt.js`: erkennt Posten und Summe im OCR-Text
- `src/ocr.js`: Bildaufbereitung (sharp) und Texterkennung (tesseract.js, deutsche Sprachdaten offline)
- `public/`: CSS und das kleine Skript für das Rechnungsformular
