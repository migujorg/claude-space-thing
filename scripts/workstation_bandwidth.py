"""Control download concurrency against a 60-second measured receive-rate target."""
from collections import deque
import json
from pathlib import Path
import time
import math

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/cache"
samples = deque()
limit = 4
try:
    saved = json.loads((CACHE / "network-control.json").read_text())
    # Resume from a measured successful operating point after reboot rather
    # than spending several minutes rediscovering concurrency from four slots.
    limit = max(1, int(saved.get("bestConcurrency", limit)))
except (OSError, ValueError, TypeError):
    pass
target = 75_000_000
probe_started = time.time()
previous_rate = None
previous_limit = limit
best_rate = 0
best_limit = limit
loss_windows = 0
while True:
    now = time.time()
    total = 0
    demand = 0
    waiting = 0
    for path in (CACHE / "network-metrics").glob("*.json"):
        try:
            metric = json.loads(path.read_text())
            total += metric.get("receivedBytes", metric.get("bytes", 0))
            if now - metric.get("updatedAt", 0) < 5:
                demand += metric.get("genericWaiting", 0) + metric.get("genericActive", 0)
                waiting += metric.get("genericWaiting", 0)
        except (OSError, ValueError):
            pass
    samples.append((now, total))
    while len(samples) > 1 and samples[1][0] <= now - 60:
        samples.popleft()
    elapsed = now - samples[0][0]
    rate = (total - samples[0][1]) / elapsed if elapsed else 0
    queue_path = CACHE / "bulk-prefetch-status.json"
    if queue_path.exists():
        try:
            queue = json.loads(queue_path.read_text())
            remaining = max(0, queue.get("total", 0) - queue.get("done", 0) - queue.get("active", 0))
            demand += remaining
            waiting += remaining
        except (OSError, ValueError):
            pass
    if now - probe_started >= 60 and elapsed >= 55:
        if rate > best_rate:
            best_rate, best_limit = rate, limit
        next_limit = limit
        loss = previous_rate is not None and rate < previous_rate * 0.85 and limit > previous_limit
        loss_windows = loss_windows + 1 if loss else 0
        if best_rate and rate < best_rate * 0.7 and limit > best_limit * 2:
            # Sustained congestion compared with a measured operating point.
            next_limit = best_limit
            loss_windows = 0
        elif loss_windows >= 2:
            # Compare recent probes rather than an old rate from different archive files.
            next_limit = previous_limit
            loss_windows = 0
        elif rate < target and waiting:
            # Match the utilization deficit, with one measured probe per minute.
            # The twofold step bounds probe size, not the eventual connection count.
            factor = min(2, target / max(rate, 1))
            next_limit = min(demand, max(limit + 1, math.ceil(limit * factor)))
        previous_rate, previous_limit = rate, limit
        if next_limit != limit:
            limit = max(1, next_limit)
            probe_started = now
        else:
            probe_started = now
    # 75 MB/s is a minimum utilization target, not a throttle ceiling.
    # This is a feedback control value, not a worker-pool cap. Published API limits remain separate.
    state = {"targetMBps": 75, "windowSeconds": round(elapsed, 1), "actualMBps": round(rate / 1e6, 2),
             "genericPerHost": limit, "projectReceivedBytes": total, "genericDemand": demand,
             "queuedGenericRequests": waiting, "updatedAt": now}
    state.update(bestMBps=round(best_rate/1e6,2),bestConcurrency=best_limit)
    tmp = CACHE / "network-control.tmp"
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(CACHE / "network-control.json")
    print(f"[bandwidth] {state['actualMBps']:.2f} MB/s over {elapsed:.0f}s; target 75; generic host slots {limit}", flush=True)
    time.sleep(15)
