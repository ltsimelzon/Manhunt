"""Manhunt game server - Python standard library only.

Run:  python server.py   (then open http://localhost:8000)
Set the PORT environment variable to change the port (hosting platforms do this for you).
"""
import json
import os
import random
import secrets
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA_FILE = os.path.join(ROOT, "lobbies.json")
PORT = int(os.environ.get("PORT", 8000))
LOBBY_TTL = 48 * 3600  # lobbies idle longer than this are deleted
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I confusion
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}

FARES = ("bus", "tube")  # the only transport; runners pay a price per stop

PUBLIC_URL = os.environ.get("RENDER_EXTERNAL_URL")  # set automatically by Render
AWAKE_FOR = 90 * 60     # keep the free Render instance awake this long after the last player request
RENDER_IDLE = 15 * 60   # Render sleeps after this much time with no incoming traffic
PING_EVERY = 5 * 60

lock = threading.Lock()
lobbies = {}
last_activity = time.time()


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ---------- persistence ----------

def load_lobbies():
    global lobbies
    try:
        with open(DATA_FILE, encoding="utf-8") as f:
            lobbies = json.load(f)
        # drop lobbies saved by the old item/destination version of the game
        lobbies = {c: l for c, l in lobbies.items() if "forced" in l}
    except (FileNotFoundError, ValueError):
        lobbies = {}


def persist():
    tmp = DATA_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(lobbies, f)
        os.replace(tmp, DATA_FILE)
    except OSError as e:  # e.g. file briefly locked by a sync client
        print("warning: could not save lobbies:", e)


def purge_old():
    cutoff = now() - LOBBY_TTL
    for code in [c for c, l in lobbies.items() if l["updated"] < cutoff]:
        del lobbies[code]


# ---------- helpers ----------

def now():
    return int(time.time())


def new_id():
    return secrets.token_hex(4)


def clean(value, max_len, field, required=True):
    s = " ".join(str(value or "").split())[:max_len]
    if required and not s:
        raise ApiError(f"{field} is required")
    return s


def number(value, lo, hi, field):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ApiError(f"{field} must be a whole number")
    if not lo <= n <= hi:
        raise ApiError(f"{field} must be between {lo} and {hi}")
    return n


def feed(lobby, text):
    lobby["seq"] += 1
    lobby["feed"].append({"id": lobby["seq"], "t": now(), "text": text})
    del lobby["feed"][:-300]


def touch(lobby):
    lobby["version"] += 1
    lobby["updated"] = now()


def new_player(name):
    return {"id": new_id(), "token": secrets.token_urlsafe(16), "name": name,
            "role": "runner", "points": 0, "caught": False, "joined": time.time()}


def unique_name(lobby, name):
    if any(p["name"].lower() == name.lower() for p in lobby["players"].values()):
        raise ApiError("Someone in this lobby already has that name")


def get_lobby(code):
    lobby = lobbies.get(str(code or "").strip().upper())
    if not lobby:
        raise ApiError("Lobby not found", 404)
    return lobby


def auth(lobby, token):
    for p in lobby["players"].values():
        if token and secrets.compare_digest(p["token"], str(token)):
            return p
    raise ApiError("You are not in this lobby", 403)


def view(lobby, player_id):
    data = {k: v for k, v in lobby.items() if k != "players"}
    data["players"] = sorted(
        ({k: v for k, v in p.items() if k != "token"} for p in lobby["players"].values()),
        key=lambda p: p["joined"])
    data["you"] = player_id
    return data


def runners(lobby):
    return [p for p in lobby["players"].values() if p["role"] == "runner"]


def target(lobby, data, role=None):
    p = lobby["players"].get(str(data.get("playerId")))
    if not p:
        raise ApiError("Player not found")
    if role and p["role"] != role:
        raise ApiError(f"That player is not a {role}")
    return p


def end_game(lobby, winner, text):
    lobby["status"] = "ended"
    lobby["winner"] = winner
    feed(lobby, text)


def forced_status(lobby, quest_id):
    """'approved', 'pending' or None. Forced quests are shared: one runner completing one counts for the team."""
    states = {c["status"] for c in lobby["completions"] if c["questId"] == quest_id}
    return "approved" if "approved" in states else "pending" if "pending" in states else None


def check_forced_win(lobby):
    if (lobby["status"] == "playing" and lobby["forced"]
            and all(forced_status(lobby, q["id"]) == "approved" for q in lobby["forced"])):
        end_game(lobby, "runners", "All forced quests complete - runners win!")


# ---------- lobby creation ----------

def create_lobby(data):
    name = clean(data.get("name"), 20, "Name")
    purge_old()
    code = "".join(random.choice(CODE_CHARS) for _ in range(5))
    while code in lobbies:
        code = "".join(random.choice(CODE_CHARS) for _ in range(5))
    host = new_player(name)
    lobby = {
        "code": code, "created": now(), "updated": now(), "version": 1, "seq": 0,
        "hostId": host["id"], "status": "lobby", "winner": None,
        "requireApproval": True, "ordered": False, "fares": {"bus": 1, "tube": 2},
        "players": {host["id"]: host},
        "forced": [], "quests": [], "completions": [], "purchases": [], "feed": [],
    }
    feed(lobby, f"{name} created the lobby")
    lobbies[code] = lobby
    return {"code": code, "token": host["token"], "state": view(lobby, host["id"])}


def join_lobby(data):
    lobby = get_lobby(data.get("code"))
    name = clean(data.get("name"), 20, "Name")
    if lobby["status"] != "lobby":
        raise ApiError("That game has already started")
    if len(lobby["players"]) >= 50:
        raise ApiError("Lobby is full")
    unique_name(lobby, name)
    p = new_player(name)
    lobby["players"][p["id"]] = p
    feed(lobby, f"{name} joined")
    touch(lobby)
    return {"code": lobby["code"], "token": p["token"], "state": view(lobby, p["id"])}


# ---------- actions ----------

def require_playing(lobby):
    if lobby["status"] != "playing":
        raise ApiError("The game is not running")


def require_free_runner(lobby, me):
    require_playing(lobby)
    if me["role"] != "runner":
        raise ApiError("Only runners can do that")
    if me["caught"]:
        raise ApiError("You've been caught")


def a_set_role(lobby, me, data):
    p = target(lobby, data)
    role = data.get("role")
    if role not in ("hunter", "runner"):
        raise ApiError("Invalid role")
    p["role"] = role


def a_randomize(lobby, me, data):
    players = list(lobby["players"].values())
    if len(players) < 2:
        raise ApiError("Need at least 2 players")
    n = number(data.get("hunters"), 1, len(players) - 1, "Number of hunters")
    random.shuffle(players)
    for i, p in enumerate(players):
        p["role"] = "hunter" if i < n else "runner"
    feed(lobby, f"Roles randomised: {n} hunter{'s' if n != 1 else ''}")


def a_kick(lobby, me, data):
    p = target(lobby, data)
    if p["id"] == lobby["hostId"]:
        raise ApiError("The host can't be removed")
    del lobby["players"][p["id"]]
    feed(lobby, f"{p['name']} was removed")


def a_leave(lobby, me, data):
    if me["id"] == lobby["hostId"]:
        raise ApiError("The host can't leave")
    del lobby["players"][me["id"]]
    feed(lobby, f"{me['name']} left")


def a_settings(lobby, me, data):
    lobby["requireApproval"] = bool(data.get("requireApproval"))
    lobby["ordered"] = bool(data.get("ordered"))
    lobby["fares"] = {m: number(data.get(m), 0, 100000, f"{m.title()} price per stop") for m in FARES}


def a_add_quest(lobby, me, data):
    forced = bool(data.get("forced"))
    q = {"id": new_id(),
         "title": clean(data.get("title"), 80, "Quest title"),
         "description": clean(data.get("description"), 300, "Description", required=False)}
    if forced:
        lobby["forced"].append(q)
    else:
        q["points"] = number(data.get("points"), 1, 100000, "Points")
        lobby["quests"].append(q)
    if lobby["status"] == "playing":
        feed(lobby, f"New forced quest: {q['title']}" if forced else f"New quest: {q['title']} ({q['points']} pts)")


def a_remove_quest(lobby, me, data):
    lobby["forced"] = [q for q in lobby["forced"] if q["id"] != data.get("questId")]
    lobby["quests"] = [q for q in lobby["quests"] if q["id"] != data.get("questId")]
    check_forced_win(lobby)


def a_move_quest(lobby, me, data):
    qs = lobby["forced"]
    i = next((i for i, q in enumerate(qs) if q["id"] == data.get("questId")), None)
    if i is None:
        raise ApiError("Quest not found")
    j = i + (1 if data.get("dir") == 1 else -1)
    if 0 <= j < len(qs):
        qs[i], qs[j] = qs[j], qs[i]


def a_start(lobby, me, data):
    if lobby["status"] != "lobby":
        raise ApiError("Game already started")
    roles = [p["role"] for p in lobby["players"].values()]
    if "hunter" not in roles or "runner" not in roles:
        raise ApiError("Need at least one hunter and one runner")
    if not lobby["forced"]:
        raise ApiError("Add at least one forced quest")
    lobby["status"] = "playing"
    lobby["startedAt"] = now()
    feed(lobby, "The game has started! Runners, go!")


def a_end(lobby, me, data):
    require_playing(lobby)
    winner = data.get("winner") if data.get("winner") in ("runners", "hunters") else None
    end_game(lobby, winner, f"Host ended the game{' - ' + winner + ' win!' if winner else ''}")


def a_reset(lobby, me, data):
    lobby.update(status="lobby", winner=None, completions=[], purchases=[])
    for p in lobby["players"].values():
        p["points"] = 0
        p["caught"] = False
    feed(lobby, "Back to the lobby for a new round")


def a_claim_quest(lobby, me, data):
    require_free_runner(lobby, me)
    qid = data.get("questId")
    forced = next((q for q in lobby["forced"] if q["id"] == qid), None)
    q = forced or next((q for q in lobby["quests"] if q["id"] == qid), None)
    if not q:
        raise ApiError("Quest not found")
    if forced:
        st = forced_status(lobby, q["id"])
        if st:
            raise ApiError("This quest is already done" if st == "approved"
                           else "This quest is already waiting for approval")
        if lobby["ordered"]:
            first = next(f for f in lobby["forced"] if forced_status(lobby, f["id"]) != "approved")
            if first is not q:
                raise ApiError(f"Complete \"{first['title']}\" first")
    elif any(c["questId"] == q["id"] and c["playerId"] == me["id"] and c["status"] != "rejected"
             for c in lobby["completions"]):
        raise ApiError("You've already submitted this quest")
    c = {"id": new_id(), "questId": q["id"], "title": q["title"], "points": 0 if forced else q["points"],
         "forced": bool(forced), "playerId": me["id"], "name": me["name"],
         "note": clean(data.get("note"), 200, "Note", required=False),
         "status": "pending", "t": now()}
    lobby["completions"].append(c)
    if lobby["requireApproval"]:
        feed(lobby, f"{me['name']} submitted \"{q['title']}\" for approval")
    else:
        approve(lobby, c)


def approve(lobby, c):
    c["status"] = "approved"
    c["t"] = now()
    if c.get("forced"):
        done = sum(forced_status(lobby, q["id"]) == "approved" for q in lobby["forced"])
        feed(lobby, f"{c['name']} completed forced quest \"{c['title']}\" ({done}/{len(lobby['forced'])})")
        check_forced_win(lobby)
        return
    p = lobby["players"].get(c["playerId"])
    if p:
        p["points"] += c["points"]
    feed(lobby, f"{c['name']} completed \"{c['title']}\" (+{c['points']} pts)")


def a_review(lobby, me, data):
    c = next((c for c in lobby["completions"] if c["id"] == data.get("completionId")), None)
    if not c or c["status"] != "pending":
        raise ApiError("That submission is no longer pending")
    if data.get("approve"):
        approve(lobby, c)
    else:
        c["status"] = "rejected"
        feed(lobby, f"{c['name']}'s \"{c['title']}\" was rejected")


def a_ride(lobby, me, data):
    require_free_runner(lobby, me)
    mode = data.get("mode")
    if mode not in FARES:
        raise ApiError("Pick the bus or the tube")
    stops = number(data.get("stops"), 1, 200, "Number of stops")
    cost = lobby["fares"][mode] * stops
    if me["points"] < cost:
        raise ApiError(f"Not enough points ({cost} needed)")
    me["points"] -= cost
    lobby["purchases"].append({"id": new_id(), "playerId": me["id"], "name": me["name"],
                               "mode": mode, "stops": stops, "cost": cost, "t": now()})
    feed(lobby, f"{me['name']} took the {mode} {stops} stop{'s' if stops != 1 else ''} (-{cost} pts)")


def a_catch(lobby, me, data):
    require_playing(lobby)
    if me["role"] != "hunter" and me["id"] != lobby["hostId"]:
        raise ApiError("Only hunters can catch runners")
    p = target(lobby, data, "runner")
    if p["caught"]:
        raise ApiError("Already caught")
    p["caught"] = True
    feed(lobby, f"{p['name']} was caught by {me['name']}!")
    if all(r["caught"] for r in runners(lobby)):
        end_game(lobby, "hunters", "All runners caught - hunters win!")


def a_release(lobby, me, data):
    require_playing(lobby)
    p = target(lobby, data, "runner")
    p["caught"] = False
    feed(lobby, f"{p['name']} is back in the game")


def a_adjust_points(lobby, me, data):
    p = target(lobby, data, "runner")
    delta = number(data.get("delta"), -100000, 100000, "Amount")
    p["points"] = max(0, p["points"] + delta)
    feed(lobby, f"Host {'gave' if delta >= 0 else 'took'} {abs(delta)} pts {'to' if delta >= 0 else 'from'} {p['name']}")


HOST, ANY = "host", "any"
ACTIONS = {
    "set_role": (HOST, a_set_role), "randomize": (HOST, a_randomize), "kick": (HOST, a_kick),
    "settings": (HOST, a_settings), "add_quest": (HOST, a_add_quest),
    "remove_quest": (HOST, a_remove_quest), "move_quest": (HOST, a_move_quest), "start": (HOST, a_start),
    "end": (HOST, a_end), "reset": (HOST, a_reset), "review": (HOST, a_review),
    "release": (HOST, a_release), "adjust_points": (HOST, a_adjust_points),
    "leave": (ANY, a_leave), "claim_quest": (ANY, a_claim_quest), "ride": (ANY, a_ride),
    "catch": (ANY, a_catch),
}


def do_action(data):
    lobby = get_lobby(data.get("code"))
    me = auth(lobby, data.get("token"))
    perm, fn = ACTIONS.get(data.get("type"), (None, None))
    if not fn:
        raise ApiError("Unknown action")
    if perm == HOST and me["id"] != lobby["hostId"]:
        raise ApiError("Only the host can do that", 403)
    fn(lobby, me, data)
    touch(lobby)
    return view(lobby, me["id"])


# ---------- HTTP ----------

def keep_awake():
    """Ping our own public URL so Render sees traffic until AWAKE_FOR has passed since real use.
    Pings stop RENDER_IDLE early, because Render waits that long before putting the instance to sleep."""
    while True:
        time.sleep(PING_EVERY)
        if time.time() - last_activity < AWAKE_FOR - RENDER_IDLE:
            try:
                req = urllib.request.Request(PUBLIC_URL + "/ping", headers={"X-Keepalive": "1"})
                urllib.request.urlopen(req, timeout=30).close()
            except OSError as e:
                print("keep-awake ping failed:", e)


class Handler(BaseHTTPRequestHandler):
    def parse_request(self):
        ok = super().parse_request()
        if ok and not self.headers.get("X-Keepalive"):
            global last_activity
            last_activity = time.time()
        return ok

    def send(self, status, body, ctype="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/ping":
            return self.send(200, {"ok": True})
        if url.path == "/api/state":
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                with lock:
                    lobby = get_lobby(q.get("code"))
                    me = auth(lobby, q.get("token"))
                    if q.get("v") == str(lobby["version"]):
                        return self.send(200, {"unchanged": True})
                    return self.send(200, view(lobby, me["id"]))
            except ApiError as e:
                return self.send(e.status, {"error": str(e)})
        if url.path in STATIC_FILES:
            name, ctype = STATIC_FILES[url.path]
            with open(os.path.join(STATIC, name), "rb") as f:
                return self.send(200, f.read(), ctype)
        self.send(404, {"error": "Not found"})

    def do_POST(self):
        routes = {"/api/create": create_lobby, "/api/join": join_lobby, "/api/action": do_action}
        fn = routes.get(urlparse(self.path).path)
        if not fn:
            return self.send(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 20000:
                raise ApiError("Request too large", 413)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                raise ApiError("Invalid JSON")
            if not isinstance(data, dict):
                raise ApiError("Invalid request")
            with lock:
                result = fn(data)
                persist()
            self.send(200, result)
        except ApiError as e:
            self.send(e.status, {"error": str(e)})

    def log_message(self, fmt, *args):
        pass  # keep the console quiet; clients poll every couple of seconds


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "localhost"


if __name__ == "__main__":
    load_lobbies()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Manhunt running at http://localhost:{PORT}")
    print(f"On the same Wi-Fi, friends can use http://{lan_ip()}:{PORT}")
    if PUBLIC_URL:
        threading.Thread(target=keep_awake, daemon=True).start()
        print(f"Keep-awake on: staying up {AWAKE_FOR // 60} min after the last player request")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
