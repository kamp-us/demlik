"""Exercise the real native runtime over its loopback API (use a spare instance)."""
import json
import sys
import time
from urllib.request import Request, urlopen

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4319"


def get():
    with urlopen(base + "/api/state", timeout=3) as response:
        return json.load(response)


def send(action, **fields):
    request = Request(base + "/api/action", data=json.dumps({"action": action, **fields}).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=3) as response:
        return json.load(response)


def until(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = get()
        if predicate(state):
            return state
        time.sleep(.04)
    raise AssertionError(json.dumps(state, ensure_ascii=False)[:2000])


send("pause", paused=True)
until(lambda s: s["paused"])
for table, glasses in [(1, 2), (2, 1), (3, 3)]:
    send("order", table=table, glasses=glasses)
state = get()
assert len(state["pending"]) == 3 and not state["model"]["orders"]
send("step")
state = until(lambda s: len(s["model"]["orders"]) == 1)
assert len(state["pending"]) == 2 and state["paused"]
print("PASS: real bounded inbox retains three messages while paused; step processes one")
send("speed", speed=4)
send("pause", paused=False)
until(lambda s: len(s["model"]["orders"]) == 3)
send("heat")
until(lambda s: s["model"]["phase"] == "heating")
send("order", table=1, glasses=1)
state = until(lambda s: len(s["model"]["orders"]) == 4)
assert state["model"]["phase"] == "heating"
send("cancel", id=4)
until(lambda s: s["model"]["orders"][3]["status"] == "cancelled")
print("PASS: another order is processed and cancelled while the heating task waits")
until(lambda s: s["model"]["phase"] == "hot")
send("brew")
until(lambda s: s["model"]["phase"] == "ready")
for order in [1, 2, 3]:
    send("serve", id=order)
state = until(lambda s: s["model"]["served"] == 6)
assert (state["model"]["water"], state["model"]["leaves"], state["model"]["tea"]) == (6, 3, 0)
assert all(o["status"] == "served" for o in state["model"]["orders"][:3])
assert {"HeatWater", "SteepTea", "DeliverTea"}.issubset({e["name"] for e in state["events"] if e["kind"] == "effect"})
assert {"HeatFinished", "BrewFinished", "ServeFinished"}.issubset({e["name"] for e in state["events"] if e["kind"] == "update"})
print("PASS: three tables receive six glasses through native commands and completion messages")
send("reset")
until(lambda s: s["model"]["generation"] == 1)
send("empty_water")
until(lambda s: s["model"]["water"] == 0)
send("heat")
state = until(lambda s: s["model"]["error"] is not None)
assert state["model"]["phase"] == "cold"
assert any(e["name"] == "HeatFinished" and "Err" in e["payload"].get("result", {}) for e in state["events"])
send("refill")
until(lambda s: s["model"]["water"] == 12)
send("heat")
state = until(lambda s: s["model"]["phase"] == "hot")
assert state["model"]["error"] is None
print("PASS: empty-water failure returns as Err, refill and retry recover")
