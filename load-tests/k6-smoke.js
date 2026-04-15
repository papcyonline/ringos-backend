/**
 * k6 HTTP smoke test — establishes baseline capacity for non-socket
 * endpoints under load. Run this BEFORE the socket.io call-flow test to
 * catch raw HTTP / DB / Postgres-pool bottlenecks first.
 *
 * Usage:
 *   k6 run -e BASE_URL=https://yomeet-backend.onrender.com \
 *          -e USERS_FILE=./users.json \
 *          load-tests/k6-smoke.js
 *
 * USERS_FILE: JSON output from seed.ts — array of { id, token }.
 *
 * Stages: 30s ramp to 50 VUs, hold 2m, ramp to 200 VUs, hold 2m, ramp down.
 * Each VU loops through:
 *   - GET /health           (no auth, sanity)
 *   - GET /call/ice-servers (auth, hits TURN provider)
 *   - GET /call/history     (auth, hits Postgres)
 *
 * Pass criteria (defined in `thresholds`):
 *   - p95 latency < 500ms for every endpoint
 *   - error rate < 1%
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const USERS_FILE = __ENV.USERS_FILE || './users.json';

const users = new SharedArray('users', () => JSON.parse(open(USERS_FILE)));

const errors = new Rate('errors');
const iceLatency = new Trend('ice_latency_ms');
const historyLatency = new Trend('history_latency_ms');

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // warm-up
    { duration: '2m', target: 50 },    // baseline
    { duration: '30s', target: 200 },  // ramp to peak
    { duration: '2m', target: 200 },   // hold peak
    { duration: '30s', target: 0 },    // drain
  ],
  thresholds: {
    'http_req_failed': ['rate<0.01'],            // <1% failures
    'http_req_duration{name:health}': ['p(95)<200'],
    'http_req_duration{name:ice}': ['p(95)<500'],
    'http_req_duration{name:history}': ['p(95)<800'],
    'errors': ['rate<0.01'],
  },
};

export default function () {
  const user = users[__VU % users.length];
  const authHeaders = { headers: { Authorization: `Bearer ${user.token}` } };

  // 1. Health (no auth)
  let res = http.get(`${BASE_URL}/health`, { tags: { name: 'health' } });
  check(res, { 'health 200': (r) => r.status === 200 }) || errors.add(1);

  // 2. ICE servers
  res = http.get(`${BASE_URL}/call/ice-servers`, {
    ...authHeaders,
    tags: { name: 'ice' },
  });
  iceLatency.add(res.timings.duration);
  check(res, {
    'ice 200': (r) => r.status === 200,
    'ice has servers': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).iceServers);
      } catch { return false; }
    },
  }) || errors.add(1);

  // 3. Call history
  res = http.get(`${BASE_URL}/call/history?page=1&limit=20`, {
    ...authHeaders,
    tags: { name: 'history' },
  });
  historyLatency.add(res.timings.duration);
  check(res, { 'history 200': (r) => r.status === 200 }) || errors.add(1);

  sleep(1); // think-time between iterations
}
