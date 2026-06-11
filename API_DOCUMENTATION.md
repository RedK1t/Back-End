# RedKit Orchestrator API

A small Node/Express service that gives **each Supabase user their own browser
container** on demand. When a user clicks **Open Browser** in the interceptor, the
front-end calls this service, which creates (or restarts) a dedicated Kali
container running noVNC + the proxy-interceptor backend, and returns the URLs the
front-end should use. Containers are stopped automatically after **5 minutes**
without a heartbeat.

- **Control API (local):** `http://localhost:3008` — create/stop/heartbeat/status.
- **Data gateway (local):** `http://localhost:3009` — the **only** way to reach a
  container's noVNC/proxy. Containers no longer publish host ports.
- **Tech:** Express + [dockerode](https://github.com/apocas/dockerode) over the
  host Docker socket + [http-proxy](https://github.com/http-party/node-http-proxy).
- **Image spawned per user:** `kalinew:latest` (built from `../Docker`).

## Why a gateway?

Publishing each container's noVNC (`6080`) and proxy (`5050`) to host ports left
them open to **anyone on the host** — a user could reach another user's container
by hitting its port. Now containers only join a private Docker network and are
reached **exclusively** through an authenticated gateway that routes each
connection to the requesting user's container, identified by a signed credential
(never a port or a client-supplied id).

---

## Authentication

All `/session/*` endpoints require a **Supabase access token** as a Bearer token:

```
Authorization: Bearer <supabase access_token>
```

The token is the one the SPA already stores in
`localStorage["sb-<project>-auth-token"].access_token`.

The orchestrator validates it by calling Supabase's `GET /auth/v1/user` and uses
the returned `user.id` as the **only** identity. The client never sends its own
user id, so a user can only ever create/heartbeat/stop **their own** container.
Validated tokens are cached for ~60s.

Invalid/missing token → `401`.

---

## Container model

| Aspect | Value |
|---|---|
| Name | `redkit-browser-<userId>` |
| Labels | `redkit.managed=true`, `redkit.user=<userId>` |
| Ports | **not published** — container `6080` (noVNC) / `5050` (proxy WS) are reached only via the gateway over the private `redkit-net` network |
| Idle behavior | **stopped** (not removed) after `IDLE_TIMEOUT_MS` with no heartbeat |
| Reuse | next `Open` restarts the same container (state preserved) |

> Docker doesn't allow setting a container's *id*; the user id is encoded in the
> container **name** and labels instead.

## Gateway auth (tickets + cookie)

`POST /session/open` and `/session/status` return gateway URLs carrying a
short-lived **HMAC-signed ticket** (`GATEWAY_SECRET`), bound to the user id:

- **Interceptor WebSocket** (cross-origin from the SPA) →
  `ws://localhost:3009/ws?ticket=<T>`. The gateway verifies the ticket and proxies
  to that user's container `5050`.
- **VNC tab** (`window.open`) → `http://localhost:3009/vnc.html?ticket=<T>`. The
  gateway verifies the ticket, sets an **httpOnly `redkit_gw` cookie**, and proxies
  to `6080`. noVNC's same-origin assets and `/websockify` then ride the cookie.

No/invalid ticket **and** no/valid cookie → `401` (HTTP) / closed socket (WS). A
valid ticket for a user with no running session → `404`.

---

## Endpoints

### `GET /health`
No auth. Liveness check.
```json
{ "ok": true }
```

### `POST /session/open`
Creates/starts the user's container and returns its URLs. Refreshes the idle timer.

**Response 200** (URLs point at the gateway and carry a signed ticket)
```json
{
  "userId": "1f3c…",
  "vncUrl": "http://localhost:3009/vnc.html?ticket=<signed>",
  "proxyWsUrl": "ws://localhost:3009/ws?ticket=<signed>"
}
```
- `vncUrl` — open in a new tab (the browser viewer).
- `proxyWsUrl` — the interceptor connects its WebSocket here.

**Errors:** `401` (auth), `500` (`failed_to_open_session`).

### `POST /session/heartbeat`
Keeps the session alive. The front-end calls this ~every 60s while active.

**Response 200** `{ "ok": true }`
**`410`** `{ "error": "no_active_session" }` — nothing to keep alive.

### `POST /session/stop`
Stops the user's container now (kept for reuse).

**Response 200** `{ "ok": true }`

### `GET /session/status`
```json
{ "running": true, "vncUrl": "…", "proxyWsUrl": "…" }
```
or `{ "running": false }`.

---

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3008` | Control API port |
| `GATEWAY_PORT` | `3009` | Authenticated data-gateway port |
| `GATEWAY_SECRET` | — | **Required.** HMAC key for signing tickets/cookies (use a long random value) |
| `TICKET_TTL_MS` | `21600000` | Ticket/cookie lifetime (6h) |
| `DOCKER_NETWORK` | `redkit-net` | Private network the containers + gateway share |
| `IDLE_TIMEOUT_MS` | `300000` | Idle-stop timeout (5 min) |
| `PUBLIC_HOST` | `localhost` | Host the front-end uses to reach the gateway |
| `KALI_IMAGE` | `kalinew:latest` | Per-user container image |
| `VNC_CONTAINER_PORT` | `6080` | noVNC port inside the container (gateway target) |
| `PROXY_CONTAINER_PORT` | `5050` | Proxy WS port inside the container (gateway target) |
| `SUPABASE_URL` | — | Supabase project URL (token validation) |
| `SUPABASE_ANON_KEY` | — | Supabase anon/publishable key |

---

## Running

```bash
# 1. Build the browser image the orchestrator spawns:
docker compose build Kali

# 2. Start the orchestrator (and front-end):
docker compose up -d --build orchestrator frontend
```

The orchestrator **must** have the Docker socket mounted
(`/var/run/docker.sock:/var/run/docker.sock`, already set in `docker-compose.yaml`)
so it can manage sibling containers.

> ⚠️ **Privilege note:** mounting the Docker socket gives this service
> root-equivalent control of the host Docker daemon. It's gated behind Supabase
> auth; for production hardening see `DEPLOYMENT.md`.

## Cleanup

Per-user containers are created as siblings (not part of the compose project), so
`docker compose down` won't remove them. To list/remove:

```bash
docker ps -a --filter label=redkit.managed=true
docker rm -f $(docker ps -aq --filter label=redkit.managed=true)
```
