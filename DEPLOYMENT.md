# Deploying RedKit Per-User Browser Containers

This guide explains how to run the per-user browser-container feature **on a
server** that real users reach over the internet — not just on your laptop.

> **Update — an authenticated gateway now exists.** The orchestrator already runs a
> data gateway on `GATEWAY_PORT` (3009) that is the *only* way into a container
> (containers no longer publish host ports; access is gated by signed tickets/cookies
> — see `API_DOCUMENTATION.md`). So the production task is no longer "build a reverse
> proxy from scratch" — it's mainly **putting TLS in front of ports 3008 (control)
> and 3009 (gateway)** and setting `PUBLIC_HOST`/scheme to your domain. The
> Caddy/Traefik section below still applies for **TLS termination and a single public
> origin** (which also lets you drop the URL ticket in favour of pure cookies, since
> the SPA and gateway then share an origin). Use `wss://` for the gateway in prod.

---

## 1. Why the local setup doesn't deploy as-is

Locally the orchestrator returns URLs like:

```
vncUrl:     http://localhost:32801/vnc.html
proxyWsUrl: ws://localhost:32802/ws
```

`localhost` resolves to **the user's own machine**, and the random high ports are
only published on the host running Docker. On a server you must instead:

1. Expose containers through the **server's public hostname**, and
2. ideally through **one stable TLS port (443)** — not thousands of random ports
   (a firewall/cloud LB would never allow that, and there's no TLS on them).

So deployment swaps *dynamic host ports* for a **reverse proxy that routes by user**.

---

## 2. Recommended: single VM + Caddy reverse proxy

This is the simplest correct deployment. One VM runs Docker, the orchestrator,
and a reverse proxy that fronts everything on `443`.

### 2.1 Provision

- A VM with Docker + Docker Compose. Size for concurrency: **each** Kali +
  Chromium session is heavy (~1–2 GB RAM). Budget e.g. 16 GB for ~6–8 sessions.
- A domain, e.g. `app.example.com`, pointing at the VM.

### 2.2 Put Caddy in front (only public entrypoint)

Caddy serves the front-end and proxies the APIs and per-user browser traffic.
It also gets you automatic HTTPS (Let's Encrypt) for free.

`Caddyfile`:

```caddyfile
app.example.com {
    # Front-end (built static site or the frontend container)
    handle /assets/* {
        reverse_proxy frontend:5173
    }

    # Orchestrator REST API
    handle /orchestrator/* {
        uri strip_prefix /orchestrator
        reverse_proxy orchestrator:3008
    }

    # Per-user browser containers (noVNC + proxy WS).
    # /browser/<userId>/... -> that user's container on the shared docker network.
    # Caddy upgrades WebSockets automatically.
    handle_path /browser/* {
        reverse_proxy {
            # dynamic upstreams are written by the orchestrator (see 2.3)
            to dynamic
        }
    }

    handle {
        reverse_proxy frontend:5173
    }
}
```

> The exact `/browser/*` routing is easiest with **Traefik** + Docker labels (each
> container gets a router rule by label) instead of hand-managing Caddy upstreams.
> Either works; the principle is the same: route `/<userId>/` to that container.

### 2.3 Change vs the local design (orchestrator)

Instead of publishing random host ports, change the orchestrator to:

1. **Attach each container to a shared Docker network** (e.g. `redkit-net`) and
   **stop publishing host ports**. Containers are reached by the reverse proxy
   over that network by name (`redkit-browser-<userId>:6080`).
2. **Return path-based URLs**:
   ```json
   {
     "vncUrl":     "https://app.example.com/browser/<userId>/vnc.html",
     "proxyWsUrl": "wss://app.example.com/browser/<userId>/ws"
   }
   ```
3. **Register a reverse-proxy route** for the user on `session/open` and **remove
   it on stop**:
   - **Traefik:** add labels at container-create time, e.g.
     ``traefik.http.routers.u-<id>.rule=PathPrefix(`/browser/<id>`)`` and a
     `stripprefix` middleware. Traefik picks them up automatically — no orchestrator
     route-writing code needed. **This is the least-code option.**
   - **Caddy:** call Caddy's admin API to add/remove an upstream for the path.

The auth, idle-stop, naming, and lifecycle logic are all unchanged.

### 2.4 Environment on the server

- Orchestrator `.env`: real `SUPABASE_URL` / `SUPABASE_ANON_KEY` (token validation
  works remotely unchanged), `PUBLIC_HOST=app.example.com`, scheme `https/wss`.
- Front-end build-time env: point `VITE_orchestrator_REST_url` at
  `https://app.example.com/orchestrator` and rebuild (Vite bakes `VITE_*` in).

---

## 3. Production hardening

- **Docker socket = root.** The orchestrator controls the host daemon. Keep it on
  an internal network, behind auth (already), and consider a
  [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
  in front of the socket allowing only `containers` create/start/stop/inspect.
- **Resource caps per container** so one user can't exhaust the VM. In
  `docker.js`'s `createContainer` `HostConfig`, set:
  ```js
  Memory: 2 * 1024 * 1024 * 1024, // 2 GB
  NanoCpus: 1_000_000_000,        // 1 CPU
  PidsLimit: 512,
  ```
- **Cap concurrent sessions** in the orchestrator (reject `open` beyond N live
  containers) to protect the VM.
- **Hard lifetime + sweep:** keep the 5-min idle stop; also add a max-lifetime
  reaper and a periodic job that **removes** containers stopped for a long time
  (reclaim disk):
  ```bash
  docker rm $(docker ps -aq --filter label=redkit.managed=true --filter status=exited)
  ```
- **Pre-build/pull the image** on the host so the first `Open Browser` isn't slow.
- **HTTPS everywhere** (Caddy/Traefik handle certs); use `wss://` for the proxy.

---

## 4. Scale-out (future, not the initial deploy)

For many concurrent users beyond one VM:

- **Kubernetes:** one **Pod (or Job)** per session; an Ingress routes
  `/browser/<userId>` to the per-user Pod/Service. The orchestrator becomes a thin
  controller that creates/deletes Pods (same logic, K8s API instead of dockerode).
- **Docker Swarm:** services + an ingress proxy, similar idea.

Start with the single-VM + reverse-proxy setup above; move to this only when one
VM can't hold the concurrent session load.
