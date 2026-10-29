#!/usr/bin/env python3
"""Model-free smoke test of a Mesa island: join, observe, walk, pick up, place.

Works against any world that speaks the Clawblox protocol (the Clawblox engine or the
GraphysX world service). Exits non-zero when an action fails, so it is a real check.
"""
import json, math, sys, time, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"
STANDOFF = 2.5  # stop this far from the block: walking onto it shoves it away
MOVABLE = ("Block", "Rock", "Ring")

def call(method, path, body=None, session=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    if session:
        req.add_header("X-Session", session)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"{}")

def result(obs):
    return obs["player"].get("attributes", {}).get("LastActionResult")

def movables(obs):
    return {e["name"]: e for e in obs["world"]["entities"] if e["name"].startswith(MOVABLE)}

def dist(a, b, flat=False):
    axes = (0, 2) if flat else (0, 1, 2)
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in axes))

def fail(message):
    print("FAIL:", message)
    sys.exit(1)

session = call("POST", "/join?name=SmokeTest")["session"]

# A freshly started island is still dropping its block pile: wait until nothing moves.
obs = call("GET", "/observe", session=session)
for _ in range(20):
    time.sleep(0.5)
    later = call("GET", "/observe", session=session)
    before, after = movables(obs), movables(later)
    obs = later
    if before.keys() == after.keys() and all(dist(before[n]["position"], after[n]["position"]) < 0.05 for n in after):
        break
carry = movables(obs)
player = obs["player"]["position"]
print("entities:", len(obs["world"]["entities"]), "| movable:", sorted(carry))
print("player fields:", sorted(obs["player"].keys()), "| start:", player)
blocks = [e for n, e in carry.items() if n.startswith("Block")] or list(carry.values())
target = min(blocks, key=lambda e: dist(e["position"], player))
print("nearest block:", target["name"], target["position"])

# Stand beside the block, on the side facing the player.
gap = dist(target["position"], player, flat=True) or 1.0
approach = [target["position"][i] + (player[i] - target["position"][i]) * STANDOFF / gap for i in (0, 1, 2)]
approach[1] = player[1]
call("POST", "/input", {"type": "MoveTo", "data": {"position": approach}}, session)
for _ in range(40):
    time.sleep(0.25)
    obs = call("GET", "/observe", session=session)
    if dist(obs["player"]["position"], approach, flat=True) < 1.0:
        break
player = obs["player"]["position"]
block = movables(obs)[target["name"]]
print("arrived near:", player, "| block now at:", block["position"])

obs = call("POST", "/input", {"type": "Pickup", "data": {"position": block["position"]}}, session)
print("Pickup ->", result(obs))
if result(obs) != "PickupSuccess":
    fail(f"Pickup returned {result(obs)}")

# Set it down beside the player, away from where it was. Observations round positions to
# 0.01 and Clawblox refuses any overlap (a block resting at 0.375 reads 0.37), so drop it
# from 0.1 above its resting height. A neighbour may occupy one spot: try three sides.
away = [block["position"][i] - player[i] for i in (0, 2)]
norm = math.hypot(*away) or 1.0
ax, az = away[0] / norm, away[1] / norm
time.sleep(0.3)
for dx, dz in ((-az, ax), (az, -ax), (-ax, -az)):
    drop = [player[0] + dx * STANDOFF, block["position"][1] + 0.1, player[2] + dz * STANDOFF]
    obs = call("POST", "/input", {"type": "Place", "data": {"position": drop}}, session)
    print("Place ->", result(obs), "at", [round(v, 2) for v in drop])
    if result(obs) != "PlaceFailed:Occupied":
        break
if result(obs) != "PlaceSuccess":
    fail(f"Place returned {result(obs)}")

time.sleep(1)
final = movables(call("GET", "/observe", session=session))[target["name"]]["position"]
print(target["name"], "now at:", final)
if dist(final, drop) > 1.0:
    fail(f"{target['name']} rests {dist(final, drop):.2f} from the drop point")
print("OK")
