// docker.js — thin wrapper around dockerode for managing per-user Kali containers.
//
// Docker does not let us choose a container's id (that's a daemon-generated hash),
// so we encode the user id in the container NAME (`redkit-browser-<userId>`) and in
// labels. Containers DO NOT publish ports to the host — that would let anyone hit a
// container directly. Instead each joins a dedicated bridge network and is reached
// only by the authenticated gateway via its internal IP.

const Docker = require("dockerode");
const net = require("net");

const docker = new Docker(); // talks to /var/run/docker.sock by default

const KALI_IMAGE = process.env.KALI_IMAGE || "kalinew:latest";
const VNC_PORT = process.env.VNC_CONTAINER_PORT || "6080";
const PROXY_PORT = process.env.PROXY_CONTAINER_PORT || "5050";
const NETWORK = process.env.DOCKER_NETWORK || "redkit-net";

const MANAGED_LABEL = "redkit.managed";
const USER_LABEL = "redkit.user";

// Create the dedicated bridge network if it doesn't exist yet.
async function ensureNetwork() {
  const nets = await docker.listNetworks({ filters: { name: [NETWORK] } });
  if (nets.find((n) => n.Name === NETWORK)) return;
  await docker.createNetwork({ Name: NETWORK, Driver: "bridge" });
  console.log(`[docker] created network ${NETWORK}`);
}

function containerName(userId) {
  // Supabase ids are UUIDs which are valid Docker names; sanitize defensively.
  const safe = String(userId).replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `redkit-browser-${safe}`;
}

// Find an existing container for this user (any state) or return null.
async function findContainer(userId) {
  const name = containerName(userId);
  const list = await docker.listContainers({
    all: true,
    filters: { name: [name] },
  });
  // Docker name filter is a substring match; require an exact "/name".
  const match = list.find((c) => c.Names.includes(`/${name}`));
  return match ? docker.getContainer(match.Id) : null;
}

// Does a Docker network with this id still exist? Used to detect containers left
// bound to a network that was recreated with a fresh id (e.g. `docker compose up`
// tears down and recreates redkit-net). Docker refuses to start such containers
// with "network ... not found".
async function networkExists(id) {
  if (!id) return false;
  try {
    await docker.getNetwork(id).inspect();
    return true;
  } catch {
    return false;
  }
}

// Read the container's IP on our dedicated network (how the gateway reaches it).
function readTarget(inspectInfo) {
  const net = (inspectInfo.NetworkSettings.Networks || {})[NETWORK];
  const ip = net && net.IPAddress;
  if (!ip) {
    throw new Error("container IP on network not available yet");
  }
  return { ip };
}

// Ensure the user's container exists and is running; return its network target { ip }.
async function ensureRunning(userId) {
  let container = await findContainer(userId);

  // A container created in an earlier run can be bound to a network that no
  // longer exists (recreated with a new id by `docker compose up`). Starting it
  // then fails with "network not found" — forever, since we keep reusing it.
  // Detect a stale/missing network binding and recreate the container fresh.
  if (container) {
    const existing = await container.inspect();
    const bound = (existing.NetworkSettings.Networks || {})[NETWORK];
    if (!bound || !(await networkExists(bound.NetworkID))) {
      console.log(
        `[docker] recreating container for user ${userId}: network binding is stale`
      );
      await container.remove({ force: true });
      container = null;
    }
  }

  if (!container) {
    container = await docker.createContainer({
      Image: KALI_IMAGE,
      name: containerName(userId),
      Labels: { [MANAGED_LABEL]: "true", [USER_LABEL]: String(userId) },
      // Exposed (not published) — reachable only inside the Docker network.
      ExposedPorts: {
        [`${VNC_PORT}/tcp`]: {},
        [`${PROXY_PORT}/tcp`]: {},
      },
      HostConfig: {
        RestartPolicy: { Name: "no" },
      },
      // Attach to the dedicated network so the gateway can reach it by IP.
      NetworkingConfig: {
        EndpointsConfig: { [NETWORK]: {} },
      },
    });
  }

  let info = await container.inspect();
  if (!info.State.Running) {
    await container.start();
    info = await container.inspect();
  }

  return readTarget(info);
}

// Read the network target of the user's container if it's running, else null.
// Used to repopulate session state after an orchestrator restart (reconcile).
async function getTarget(userId) {
  const container = await findContainer(userId);
  if (!container) return null;
  const info = await container.inspect();
  if (!info.State.Running) return null;
  try {
    return readTarget(info);
  } catch {
    return null;
  }
}

// Stop (but keep) the user's container so it can be reused later.
async function stop(userId) {
  const container = await findContainer(userId);
  if (!container) return false;
  const info = await container.inspect();
  if (info.State.Running) {
    await container.stop({ t: 5 });
  }
  return true;
}

// Remove the user's container entirely (cleanup tooling, not the idle path).
async function remove(userId) {
  const container = await findContainer(userId);
  if (!container) return false;
  await container.remove({ force: true });
  return true;
}

// Is a TCP port on the container actually accepting connections yet? The container
// "starting" (docker.start resolved) is NOT the same as its services being up — the
// entrypoint sleeps then boots VNC + supervisord (mitmproxy on PROXY_PORT), which takes
// ~10-15s. A single quick TCP connect lets the frontend show real connection progress
// instead of a premature "disconnected" screen. Resolves true on connect, false otherwise.
function probeReachable(ip, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (!ip) return resolve(false);
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(Number(port), ip);
  });
}

// List all RedKit-managed containers (used to reconcile on orchestrator startup).
async function listManaged() {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${MANAGED_LABEL}=true`] },
  });
  return list.map((c) => ({
    id: c.Id,
    userId: c.Labels[USER_LABEL],
    running: c.State === "running",
  }));
}

module.exports = {
  containerName,
  ensureNetwork,
  ensureRunning,
  getTarget,
  stop,
  remove,
  listManaged,
  findContainer,
  probeReachable,
};
