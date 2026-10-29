#!/usr/bin/env python3
"""Model-free smoke test of a Clawblox Mesa island: join, observe, walk, pick up, place."""
import json, sys, time, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"

def call(method, path, body=None, session=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    if session:
        req.add_header("X-Session", session)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"{}")

def find(o, key):
    if isinstance(o, dict):
        if key in o:
            return o[key]
        o = list(o.values())
    if isinstance(o, list):
        for v in o:
            r = find(v, key)
            if r is not None:
                return r
    return None

def entities(obs):
    out = []
    def walk(o):
        if isinstance(o, dict):
            if "name" in o and "position" in o:
                out.append(o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(obs.get("world", obs))
    return out

session = call("POST", "/join?name=SmokeTest")["session"]
obs = call("GET", "/observe", session=session)
ents = entities(obs)
carry = [e for e in ents if e["name"].startswith(("Block", "Rock", "Ring"))]
print("entities:", len(ents), "| movable:", sorted({e["name"] for e in carry}))
print("player fields:", sorted(obs["player"].keys()))
print("player start:", obs["player"].get("position"))
target = min(carry, key=lambda e: sum((a - b) ** 2 for a, b in zip(e["position"], obs["player"]["position"])))
print("nearest movable:", target["name"], target["position"])

def act(kind, data):
    o = call("POST", "/input", {"type": kind, "data": data}, session)
    time.sleep(0.2)
    return find(o, "lastActionResult"), o["player"].get("position")

print("MoveTo ->", act("MoveTo", {"position": target["position"]}))
for _ in range(40):
    time.sleep(0.5)
    p = call("GET", "/observe", session=session)["player"]["position"]
    if sum((a - b) ** 2 for a, b in zip(p, target["position"])) < 9:
        break
print("arrived near:", p)
print("Pickup ->", act("Pickup", {"position": target["position"]}))
time.sleep(0.5)
drop = [p[0] + 2, p[1], p[2]]
print("Place ->", act("Place", {"position": drop}))
time.sleep(1)
final = call("GET", "/observe", session=session)
print("lastActionResult:", find(final, "lastActionResult"))
moved = [e for e in entities(final) if e["name"] == target["name"]][0]
print(target["name"], "now at:", moved["position"])
