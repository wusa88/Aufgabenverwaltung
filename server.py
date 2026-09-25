#!/usr/bin/env python3
"""Aufgaben – schnelle Aufgabenverwaltung fürs Handy.

Liefert die App aus und hält alle Aufgaben in einer JSON-Datei. Nur Python-
Standardbibliothek, keine Abhängigkeiten, keine Verbindung nach draußen.

In DATA_DIR entstehen:
  aufgaben.json            – die maßgeblichen Daten
  aufgaben.json.bak        – die Fassung vor der letzten Änderung
  sicherung/aufgaben-JJJJ-MM-TT.json – ein Stand pro Tag, die letzten 30
  .secret                  – Schlüssel für das Login-Cookie

Umgebungsvariablen:
  DATA_DIR      Ordner für die Daten                  (Standard: ./data)
  HOST          Adresse                               (Standard: 0.0.0.0)
  PORT          Port                                  (Standard: 8080)
  APP_PASSWORD  Passwort für die Anmeldung; leer = kein Schutz
  API_TOKEN     optionaler Schlüssel für Schnelleingabe per HTTP
                (Header "Authorization: Bearer <API_TOKEN>")
  SECRET_KEY    optional; sonst wird einer in DATA_DIR/.secret erzeugt
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import struct
import sys
import threading
import time
import traceback
import unicodedata
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

HERE = Path(__file__).resolve().parent
STATIC = Path(os.environ.get("STATIC_DIR") or HERE / "app").resolve()
DATA = Path(os.environ.get("DATA_DIR") or HERE / "data").resolve()
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
PASSWORD = os.environ.get("APP_PASSWORD", "")
API_TOKEN = os.environ.get("API_TOKEN", "")

DATA_FILE = DATA / "aufgaben.json"
BAK_FILE = DATA / "aufgaben.json.bak"
BACKUP_DIR = DATA / "sicherung"
KEEP_BACKUPS = 30

COOKIE = "aufgaben_login"
COOKIE_AGE = 400 * 24 * 3600          # Obergrenze von Chrome; wird bei Nutzung verlängert
MAX_BODY = 256 * 1024
MAX_TEXT = 5000
MAX_NAME = 40

ACCENT = "#2563eb"
# Muss zu COLORS in app/app.js passen.
COLORS = ["#1c7ed6", "#0c8599", "#099268", "#2f9e44", "#5c940d", "#e67700",
          "#e8590c", "#e03131", "#c2255c", "#9c36b5", "#6741d9", "#868e96"]

ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
TAG_RE = re.compile(r"(?:^|\s)#([^\s#]{2,})")
PLUS_ICON_RE = re.compile(r"^/icons/plus-([0-9a-f]{6})\.png$")


class ApiError(Exception):
    def __init__(self, status, msg=""):
        super().__init__(msg)
        self.status = status
        self.msg = msg


# ---------------------------------------------------------------- Hilfen

def now_iso():
    """Gleiches Format wie Date.toISOString() im Browser – sortiert als Text."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse_iso(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def fold(text):
    """Kleinbuchstaben ohne Akzente – für Suche und #kategorie."""
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def compact(text):
    return "".join(ch for ch in fold(text) if ch.isalnum())


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    return value.replace("\r\n", "\n").strip()[:limit]


def new_id():
    return secrets.token_urlsafe(9)


def load_secret():
    env = os.environ.get("SECRET_KEY", "")
    if env:
        return env.encode()
    path = DATA / ".secret"
    try:
        return path.read_bytes().strip()
    except FileNotFoundError:
        key = secrets.token_hex(32).encode()
        path.write_bytes(key)
        os.chmod(path, 0o600)
        return key


# ---------------------------------------------------------------- Datenhaltung

class Store:
    """Alle Daten im Speicher, jede Änderung sofort atomar auf die Platte."""

    def __init__(self):
        self.lock = threading.RLock()
        self.data = self._load()
        self.tasks = {t["id"]: t for t in self.data["tasks"]}

    # -- Laden / Speichern

    def _load(self):
        for path in (DATA_FILE, BAK_FILE):
            if not path.exists():
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                data = self._normalize(raw)
            except (OSError, ValueError, TypeError, AttributeError) as exc:
                print(f"WARNUNG: {path.name} nicht lesbar ({exc})", file=sys.stderr)
                if path == DATA_FILE:
                    broken = DATA / f"aufgaben.json.defekt-{int(time.time())}"
                    shutil.copy2(path, broken)
                    print(f"         Kopie liegt unter {broken.name}", file=sys.stderr)
                continue
            if path == BAK_FILE:
                print("WARNUNG: Daten aus aufgaben.json.bak wiederhergestellt", file=sys.stderr)
            return data
        return {"version": 1, "categories": [], "tasks": []}

    @staticmethod
    def _normalize(raw):
        cats, seen = [], set()
        for c in raw.get("categories", []):
            cid, name = c.get("id"), clean_text(c.get("name"), MAX_NAME)
            if not (isinstance(cid, str) and ID_RE.match(cid)) or not name or cid in seen:
                continue
            seen.add(cid)
            color = c.get("color") if COLOR_RE.match(str(c.get("color", ""))) else COLORS[0]
            cats.append({"id": cid, "name": name, "color": color.lower()})
        tasks, tseen = [], set()
        for t in raw.get("tasks", []):
            tid, text = t.get("id"), clean_text(t.get("text"), MAX_TEXT)
            if not (isinstance(tid, str) and ID_RE.match(tid)) or not text or tid in tseen:
                continue
            tseen.add(tid)
            tasks.append({
                "id": tid,
                "text": text,
                "cat": t.get("cat") if t.get("cat") in seen else None,
                "star": bool(t.get("star")),
                "created": parse_iso(t.get("created")) or now_iso(),
                "done": parse_iso(t.get("done")),
            })
        return {"version": 1, "categories": cats, "tasks": tasks}

    def _dump(self):
        # Eine Zeile pro Eintrag: bleibt für Menschen lesbar und reparierbar.
        def block(items):
            if not items:
                return "[]"
            return "[\n" + ",\n".join("  " + json.dumps(i, ensure_ascii=False) for i in items) + "\n ]"
        return ('{"version": 1,\n "categories": ' + block(self.data["categories"])
                + ',\n "tasks": ' + block(self.data["tasks"]) + "\n}\n")

    def save(self):
        self._daily_backup()
        tmp = DATA_FILE.with_name(DATA_FILE.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(self._dump())
            fh.flush()
            os.fsync(fh.fileno())
        if DATA_FILE.exists():
            shutil.copy2(DATA_FILE, BAK_FILE)
        os.replace(tmp, DATA_FILE)

    def _daily_backup(self):
        if not DATA_FILE.exists():
            return
        BACKUP_DIR.mkdir(exist_ok=True)
        target = BACKUP_DIR / f"aufgaben-{datetime.now().strftime('%Y-%m-%d')}.json"
        if target.exists():
            return
        shutil.copy2(DATA_FILE, target)
        for old in sorted(BACKUP_DIR.glob("aufgaben-*.json"))[:-KEEP_BACKUPS]:
            old.unlink(missing_ok=True)

    # -- Kategorien

    def cat_ids(self):
        return {c["id"] for c in self.data["categories"]}

    def find_cat(self, word):
        """#schule → Kategorie „Schule Nord“: exakter Treffer oder eindeutiger Anfang."""
        w = compact(word)
        if len(w) < 2:
            return None
        cats = self.data["categories"]
        exact = [c for c in cats if compact(c["name"]) == w]
        if exact:
            return exact[0]
        start = [c for c in cats if compact(c["name"]).startswith(w)]
        return start[0] if len(start) == 1 else None

    def resolve_cat(self, value):
        """Kategorie aus Id oder Name; unbekannt → keine Kategorie."""
        if not isinstance(value, str) or not value or value in ("all", "none"):
            return None
        if value in self.cat_ids():
            return value
        c = self.find_cat(value)
        return c["id"] if c else None

    def parse_quick(self, text):
        """„!“ am Anfang = wichtig, „#name“ = Kategorie. Gibt (text, kat, stern)."""
        star = False
        if text.startswith("!"):
            star, text = True, text[1:].lstrip()
        cat = None
        for m in TAG_RE.finditer(text):
            c = self.find_cat(m.group(1).rstrip(".,;:!?"))
            if c:
                cat = c["id"]
                text = text[:m.start()] + text[m.end():]
                break
        text = re.sub(r"[ \t]{2,}", " ", text).strip()
        return text, cat, star

    def create_cat(self, body):
        name = clean_text(body.get("name"), MAX_NAME)
        if not name:
            raise ApiError(400, "Name fehlt")
        color = str(body.get("color") or "")
        cid = body.get("id")
        with self.lock:
            cats = self.data["categories"]
            if isinstance(cid, str) and ID_RE.match(cid):
                for c in cats:
                    if c["id"] == cid:                 # Wiederholung aus der Warteschlange
                        return 200, c
            else:
                cid = new_id()
            if not COLOR_RE.match(color):
                used = {c["color"] for c in cats}
                color = next((x for x in COLORS if x not in used), COLORS[len(cats) % len(COLORS)])
            cat = {"id": cid, "name": name, "color": color.lower()}
            cats.append(cat)
            self.save()
            return 201, cat

    def patch_cat(self, cid, body):
        with self.lock:
            cat = next((c for c in self.data["categories"] if c["id"] == cid), None)
            if not cat:
                raise ApiError(404, "Kategorie nicht gefunden")
            if "name" in body:
                name = clean_text(body["name"], MAX_NAME)
                if not name:
                    raise ApiError(400, "Name fehlt")
                cat["name"] = name
            if "color" in body:
                if not COLOR_RE.match(str(body["color"])):
                    raise ApiError(400, "Ungültige Farbe")
                cat["color"] = body["color"].lower()
            self.save()
            return cat

    def order_cats(self, ids):
        if not isinstance(ids, list):
            raise ApiError(400, "ids fehlt")
        with self.lock:
            cats = self.data["categories"]
            pos = {cid: i for i, cid in enumerate(ids) if isinstance(cid, str)}
            cats.sort(key=lambda c: pos.get(c["id"], len(pos)))
            self.save()
            return cats

    def delete_cat(self, cid):
        with self.lock:
            cats = self.data["categories"]
            if not any(c["id"] == cid for c in cats):
                return
            self.data["categories"] = [c for c in cats if c["id"] != cid]
            for t in self.data["tasks"]:
                if t["cat"] == cid:
                    t["cat"] = None
            self.save()

    # -- Aufgaben

    def create_task(self, body):
        text = clean_text(body.get("text"), MAX_TEXT)
        tid = body.get("id")
        with self.lock:
            if isinstance(tid, str) and ID_RE.match(tid):
                if tid in self.tasks:                  # Wiederholung aus der Warteschlange
                    return 200, self.tasks[tid]
            else:
                tid = new_id()
            text, tag_cat, star = self.parse_quick(text)
            if not text:
                raise ApiError(400, "Text fehlt")
            done = body.get("done")
            task = {
                "id": tid,
                "text": text,
                "cat": self.resolve_cat(body.get("cat")) or tag_cat,
                "star": bool(body.get("star")) or star,
                "created": parse_iso(body.get("created")) or now_iso(),
                "done": (now_iso() if done is True else parse_iso(done)),
            }
            self.data["tasks"].append(task)
            self.tasks[tid] = task
            self.save()
            return 201, task

    def patch_task(self, tid, body):
        with self.lock:
            task = self.tasks.get(tid)
            if not task:
                raise ApiError(404, "Aufgabe nicht gefunden")
            if "text" in body:
                text = clean_text(body["text"], MAX_TEXT)
                if not text:
                    raise ApiError(400, "Text fehlt")
                task["text"] = text
            if "cat" in body:
                task["cat"] = self.resolve_cat(body["cat"])
            if "star" in body:
                task["star"] = bool(body["star"])
            if "done" in body:
                v = body["done"]
                if v is True:
                    task["done"] = now_iso()
                elif v in (False, None, ""):
                    task["done"] = None
                else:
                    task["done"] = parse_iso(v)
                    if not task["done"]:
                        raise ApiError(400, "Ungültiges Datum")
            self.save()
            return task

    def delete_task(self, tid):
        with self.lock:
            if self.tasks.pop(tid, None) is None:
                return
            self.data["tasks"] = [t for t in self.data["tasks"] if t["id"] != tid]
            self.save()

    # -- Abfragen

    def state(self):
        with self.lock:
            open_tasks = [t for t in self.data["tasks"] if not t["done"]]
            open_tasks.sort(key=lambda t: t["created"], reverse=True)
            return json.dumps({
                "version": VERSION,
                "auth": bool(PASSWORD),
                "categories": self.data["categories"],
                "open": open_tasks,
            }, ensure_ascii=False)

    def done_list(self, kat, offset, limit):
        with self.lock:
            items = [t for t in self.data["tasks"] if t["done"] and (
                kat == "all" or (kat == "none" and not t["cat"]) or t["cat"] == kat)]
            items.sort(key=lambda t: t["done"], reverse=True)
            return json.dumps({"tasks": items[offset:offset + limit],
                               "more": len(items) > offset + limit}, ensure_ascii=False)

    def search(self, q, limit=100):
        words = fold(q).split()
        with self.lock:
            names = {c["id"]: fold(c["name"]) for c in self.data["categories"]}
            hits = []
            for t in self.data["tasks"]:
                hay = fold(t["text"]) + " " + names.get(t["cat"], "")
                if all(w in hay for w in words):
                    hits.append(t)
            hits.sort(key=lambda t: (not t["done"], t["done"] or t["created"]), reverse=True)
            return json.dumps({"tasks": hits[:limit], "more": len(hits) > limit}, ensure_ascii=False)

    def export(self):
        with self.lock:
            return self._dump()


# ---------------------------------------------------------------- Icons

_icon_cache = {}


def plus_icon_png(hexcolor, size=96):
    """Farbiger Kreis mit weißem Plus – Symbol für die Kurzbefehle am App-Icon."""
    if hexcolor in _icon_cache:
        return _icon_cache[hexcolor]
    r, g, b = (int(hexcolor[i:i + 2], 16) for i in (0, 2, 4))
    c, rad, arm, half = size / 2, size * 0.46, size * 0.21, size * 0.045
    ss = 4
    offs = [(i + 0.5) / ss for i in range(ss)]
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            cover = white = 0
            for oy in offs:
                dy = y + oy - c
                for ox in offs:
                    dx = x + ox - c
                    if dx * dx + dy * dy <= rad * rad:
                        cover += 1
                        if (abs(dx) <= half and abs(dy) <= arm) or (abs(dy) <= half and abs(dx) <= arm):
                            white += 1
            if not cover:
                raw += b"\0\0\0\0"
                continue
            f = white / cover
            raw += bytes((round(r + (255 - r) * f), round(g + (255 - g) * f),
                          round(b + (255 - b) * f), round(255 * cover / (ss * ss))))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    _icon_cache[hexcolor] = png
    return png


# ---------------------------------------------------------------- Auslieferung

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


def static_version():
    """Prüfsumme über alle App-Dateien. Ändert sich eine, ändert sich sw.js,
    und der Browser holt sich die neue Fassung."""
    h = hashlib.sha1()
    for f in sorted(STATIC.rglob("*")):
        if f.is_file():
            h.update(f.relative_to(STATIC).as_posix().encode())
            h.update(f.read_bytes())
    return h.hexdigest()[:10]


def manifest(authed):
    def icon(color):
        return [{"src": f"icons/plus-{color[1:].lower()}.png", "sizes": "96x96", "type": "image/png"}]

    shortcuts = [{"name": "Neue Aufgabe", "short_name": "Neue Aufgabe", "url": "./?neu", "icons": icon(ACCENT)}]
    if authed:
        with STORE.lock:
            cats = list(STORE.data["categories"][:3])
        for c in cats:
            shortcuts.append({"name": f"Neu: {c['name']}", "short_name": c["name"],
                              "url": f"./?neu&kat={c['id']}", "icons": icon(c["color"])})
    return {
        "id": "./",
        "name": "Aufgaben",
        "short_name": "Aufgaben",
        "description": "Schnell aufschreiben, nichts vergessen.",
        "lang": "de",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": "#f5f6f8",
        "theme_color": "#f5f6f8",
        "icons": [
            {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": shortcuts,
        "share_target": {
            "action": "./",
            "method": "GET",
            "params": {"title": "title", "text": "text", "url": "url"},
        },
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def version_string(self):
        return "Aufgaben"

    # -- Protokoll: ohne Query-String, damit keine Aufgabentexte im Log landen
    def log_request(self, code="-", size="-"):
        path = urlsplit(self.path).path
        if path != "/api/health":
            sys.stderr.write(f"{self.log_date_time_string()} {self.command} {path} {code}\n")

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.log_date_time_string()} {fmt % args}\n")

    # -- Antworten
    def send(self, status, body=b"", ctype=MIME[".json"], headers=(), cache="no-store"):
        self.send_response(status)
        if status != 304:
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        for k, v in headers:
            self.send_header(k, v)
        if not self._body_read and self.headers.get("Content-Length", "0") not in ("", "0"):
            # Ungelesener Rumpf (z. B. bei 401) würde sonst als nächste Anfrage gelesen.
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD" and status != 304:
            self.wfile.write(body)

    def send_json(self, status, obj, headers=()):
        body = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
        self.send(status, body.encode("utf-8"), headers=headers)

    def read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Ungültige Länge")
        if n > MAX_BODY:
            raise ApiError(413, "Zu groß")
        raw = self.rfile.read(n) if n > 0 else b""
        self._body_read = True
        ctype = self.headers.get("Content-Type", "").lower()
        text = raw.decode("utf-8", "replace")
        if "json" in ctype or text.lstrip().startswith("{"):
            try:
                data = json.loads(text or "{}")
            except ValueError:
                raise ApiError(400, "Ungültiges JSON")
            if not isinstance(data, dict):
                raise ApiError(400, "Objekt erwartet")
            return data
        if "form-urlencoded" in ctype:
            return {k: v[0] for k, v in parse_qs(text).items()}
        return {"text": text}                         # text/plain, z. B. aus HTTP Shortcuts

    # -- Anmeldung
    def cookie_value(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return ""

    def cookie_header(self, value, max_age):
        parts = [f"{COOKIE}={value}", "Path=/", f"Max-Age={max_age}", "HttpOnly", "SameSite=Lax"]
        if self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https":
            parts.append("Secure")
        return ("Set-Cookie", "; ".join(parts))

    def cookie_ok(self):
        return hmac.compare_digest(self.cookie_value().encode(), LOGIN_TOKEN.encode())

    def authed(self):
        if not PASSWORD or self.cookie_ok():
            return True
        auth = self.headers.get("Authorization", "")
        if API_TOKEN and auth[:7].lower() == "bearer ":
            return hmac.compare_digest(auth[7:].strip().encode(), API_TOKEN.encode())
        return False

    def login(self):
        pw = self.read_body().get("password", "")
        if PASSWORD:
            # Ein Versuch pro Sekunde, egal wie viele parallel kommen.
            with LOGIN_LOCK:
                ok = isinstance(pw, str) and hmac.compare_digest(pw.encode(), PASSWORD.encode())
                if not ok:
                    time.sleep(1)
            if not ok:
                raise ApiError(401, "Falsches Passwort")
        self.send_json(200, {"ok": True}, headers=[self.cookie_header(LOGIN_TOKEN, COOKIE_AGE)])

    # -- Verteiler
    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        self._body_read = False
        try:
            url = urlsplit(self.path)
            if url.path.startswith("/api/"):
                self.api(method, url.path[5:], parse_qs(url.query))
            elif method == "GET":
                self.static(url.path)
            else:
                raise ApiError(405, "Nicht erlaubt")
        except ApiError as e:
            self.send_json(e.status, {"error": e.msg})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.send_json(500, {"error": "Interner Fehler"})
            except OSError:
                pass

    def api(self, method, route, query):
        if route == "health":
            return self.send_json(200, {"ok": True})
        if route == "login" and method == "POST":
            return self.login()
        if route == "logout" and method == "POST":
            return self.send_json(200, {"ok": True}, headers=[self.cookie_header("", 0)])
        if not self.authed():
            raise ApiError(401, "Anmeldung nötig")

        def q(name, default=""):
            return query.get(name, [default])[0]

        def num(name, default, hi):
            try:
                return max(0, min(hi, int(q(name, default))))
            except ValueError:
                return default

        match method, route.split("/"):
            case "GET", ["state"]:
                # Login bei jeder Nutzung verlängern, sonst läuft er nach 400 Tagen ab.
                extra = [self.cookie_header(LOGIN_TOKEN, COOKIE_AGE)] if PASSWORD and self.cookie_ok() else []
                self.send_json(200, STORE.state(), headers=extra)
            case "GET", ["done"]:
                self.send_json(200, STORE.done_list(q("kat", "all"), num("offset", 0, 10**7), num("limit", 50, 200)))
            case "GET", ["search"]:
                self.send_json(200, STORE.search(q("q")))
            case "GET", ["export"]:
                name = f"aufgaben-{datetime.now().strftime('%Y-%m-%d')}.json"
                self.send(200, STORE.export().encode("utf-8"),
                          headers=[("Content-Disposition", f'attachment; filename="{name}"')])
            case "POST", ["tasks"]:
                status, task = STORE.create_task(self.read_body())
                self.send_json(status, task)
            case "PATCH", ["tasks", tid]:
                self.send_json(200, STORE.patch_task(tid, self.read_body()))
            case "DELETE", ["tasks", tid]:
                STORE.delete_task(tid)
                self.send_json(200, {"ok": True})
            case "POST", ["categories"]:
                status, cat = STORE.create_cat(self.read_body())
                self.send_json(status, cat)
            case "PUT", ["categories", "order"]:
                self.send_json(200, STORE.order_cats(self.read_body().get("ids")))
            case "PATCH", ["categories", cid]:
                self.send_json(200, STORE.patch_cat(cid, self.read_body()))
            case "DELETE", ["categories", cid]:
                STORE.delete_cat(cid)
                self.send_json(200, {"ok": True})
            case _:
                raise ApiError(404, "Unbekannter Endpunkt")

    def static(self, path):
        if path == "/sw.js":
            return self.send(200, SW_BODY, MIME[".js"], cache="no-cache")
        if path == "/manifest.webmanifest":
            body = json.dumps(manifest(self.authed()), ensure_ascii=False, indent=1).encode()
            return self.send(200, body, "application/manifest+json; charset=utf-8",
                             headers=[("Vary", "Cookie")], cache="no-cache")
        m = PLUS_ICON_RE.match(path)
        if m:
            color = "#" + m.group(1)
            with STORE.lock:
                allowed = set(COLORS) | {ACCENT} | {c["color"] for c in STORE.data["categories"]}
            if color not in allowed:
                raise ApiError(404, "Nicht gefunden")
            return self.send(200, plus_icon_png(m.group(1)), MIME[".png"], cache="public, max-age=604800")

        rel = "index.html" if path in ("/", "/index.html") else unquote(path).lstrip("/")
        try:
            f = (STATIC / rel).resolve()
        except (ValueError, OSError):                  # z. B. Null-Byte im Pfad
            raise ApiError(404, "Nicht gefunden")
        if STATIC not in f.parents or not f.is_file() or f.name == "sw.js":
            raise ApiError(404, "Nicht gefunden")
        data = f.read_bytes()
        etag = '"' + hashlib.sha1(data).hexdigest()[:16] + '"'
        if self.headers.get("If-None-Match") == etag:
            return self.send(304, headers=[("ETag", etag)], cache="no-cache")
        self.send(200, data, MIME.get(f.suffix, "application/octet-stream"),
                  headers=[("ETag", etag)], cache="no-cache")


# ---------------------------------------------------------------- Start

def main():
    global STORE, VERSION, SW_BODY, LOGIN_TOKEN, LOGIN_LOCK
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        probe = DATA / ".schreibtest"
        probe.write_text("ok")
        probe.unlink()
    except OSError as exc:
        sys.exit(f"FEHLER: {DATA} ist nicht beschreibbar ({exc}). "
                 "Bei einem Bind-Mount den Ordner auf dem Host UID 1000 geben.")

    STORE = Store()
    VERSION = static_version()
    SW_BODY = (STATIC / "sw.js").read_text(encoding="utf-8").replace("__VERSION__", VERSION).encode()
    LOGIN_TOKEN = hmac.new(load_secret(), b"login:" + PASSWORD.encode(), hashlib.sha256).hexdigest()
    LOGIN_LOCK = threading.Lock()

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=srv.shutdown).start())
    print(f"Aufgaben läuft auf http://{HOST}:{PORT}  (Daten: {DATA}, Version {VERSION})", flush=True)
    if not PASSWORD:
        print("HINWEIS: APP_PASSWORD ist leer – die App ist ohne Anmeldung erreichbar.", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    srv.server_close()


STORE = VERSION = SW_BODY = LOGIN_TOKEN = LOGIN_LOCK = None

if __name__ == "__main__":
    main()
