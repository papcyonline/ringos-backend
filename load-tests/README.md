# Load tests

Three small scripts. Use in this order: smoke first to validate the HTTP
path, then the call signalling test once smoke passes.

## What you need

- A **non-prod** Postgres + Redis backend reachable from your machine
- The same `JWT_SECRET` that backend uses (so we can mint test tokens)
- `LOAD_TEST_DB_URL` exported (refuses to seed without it)

```bash
export LOAD_TEST_DB_URL="postgres://user:pass@host:5432/yomeet_loadtest"
export JWT_SECRET="<must match the target backend>"
export TARGET="https://yomeet-staging.example.com"   # or http://localhost:3000
```

## 1. Seed test users

```bash
cd Backend
npx ts-node load-tests/seed.ts --pairs 200 --out load-tests/users.json
```

Creates 200 user pairs (caller + callee) and a conversation per pair.
Output schema: `[{ id, token, calleeId, conversationId }, ...]`.

To remove them later:

```bash
npx ts-node load-tests/seed.ts --cleanup
```

## 2. HTTP smoke (k6)

Validates auth, ICE servers, and call history under load. Run BEFORE the
socket test — if the HTTP path is unhealthy, signalling will be too.

```bash
brew install k6   # or your platform's installer

k6 run \
  -e BASE_URL=$TARGET \
  -e USERS_FILE=load-tests/users.json \
  load-tests/k6-smoke.js
```

Default profile: ramps to 200 VUs over 5 minutes. Adjust `options.stages`
in the script for heavier load.

**Pass:** all `thresholds` green (p95 latencies + <1% errors).
**Fail:** investigate Render logs / DB pool exhaustion before doing #3.

## 3. Call signalling (Artillery)

Measures `call:initiate` throughput. Each VU connects via socket.io with
its minted JWT, emits `call:initiate`, awaits `call:initiated`.

```bash
npm install -g artillery@latest
npm install -g @artilleryio/engine-socketio-v3

artillery run \
  --target $TARGET \
  --variables "{\"usersFile\":\"./load-tests/users.json\"}" \
  load-tests/calls.yml
```

Default profile: 5 → 100 arrivals/sec ramping over ~9 minutes, peak
sustained for 5 min. Edit `config.phases` to push harder.

## Reading the results

| Signal | Healthy | Unhealthy → action |
|---|---|---|
| `vusers.session_length.p95` | <1500ms | >3000ms → check Postgres pool / Redis latency |
| `errors.call:error` | <5% | >10% → likely BUSY/UNAVAILABLE; check seed pairs |
| `vusers.failed` | 0 | >0 → connections refused; instance saturated |
| `engine.io_disconnect` rate | <1% | >5% → instance crashing or memory cap |

## What this does NOT test

- **End-to-end call** (caller + callee both online, full handshake) — needs
  paired VUs which Artillery can do via two scenarios with shared state.
  Add when needed.
- **Media path / WebRTC quality** — load tests target signalling only.
  For media, use LiveKit's own load tools or
  [WebRTC-perf](https://github.com/vpalmisano/webrtcperf).
- **TURN throughput** — signalling load doesn't exercise TURN. Spin up
  iperf3 against your TURN server for that.

## When to re-run

- After every Phase change in the scaling roadmap (Redis state was Phase 1,
  CallLog write-behind was Phase 2 — both should improve numbers here)
- Before every infra change (more instances, bigger Postgres, etc.)
- Once a quarter as a regression check
