# SmartVoice mit Docker

## Voraussetzungen

Nur Docker Desktop und Git werden benötigt.

## Start

Im SmartVoice-Projektordner:

```bash
docker compose up --build -d
```

Danach im Browser öffnen:

```text
http://localhost:5173
```

Backend:

```text
http://127.0.0.1:8001
```

## Logs

```bash
docker compose logs -f
```

Nur Backend:

```bash
docker compose logs -f backend
```

## Stoppen

```bash
docker compose down
```

Die PDFs, TTS-Modelle, heruntergeladenen Stimmen und erzeugten Audiodaten
bleiben im Docker-Volume `smartvoice_data` erhalten.

## Komplett zurücksetzen

Achtung: löscht auch PDFs und heruntergeladene Stimmen.

```bash
docker compose down -v
```

## Nach einem Git-Pull neu bauen

```bash
git pull
docker compose up --build -d
```

## Hinweise

Das Frontend wird beim Image-Build mit Vite gebaut und anschließend mit nginx
ausgeliefert. Das Backend läuft mit Python 3.12 und Uvicorn.

Piper und Kokoro laufen innerhalb des Backend-Containers. Die Kokoro-Runtime
wird bereits beim Image-Build installiert, damit beim ersten Start nicht
nachträglich Python-Pakete in den laufenden Container installiert werden müssen.

SmartVoice verwendet `SMARTVOICE_DATA_DIR=/data`. Dadurch liegen veränderliche
Daten nicht im Git-Repository und nicht im Container-Dateisystem, sondern im
persistenten Docker-Volume.
