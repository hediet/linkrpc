// Spawns a real TypeScript `@hediet/linkrpc-hub` over a Unix domain socket with:
//   - capability-gated forwarding (`withForwardedCallGate`, `requireCapability: true`)
//   - inbound signature verification (`withVerifiedSignature`, `verifySignatures: true`)
//   - root-served `hubAccess` consent front door (`HubAccessGrantSigner`, permits "hello", denies "forbidden")
//   - root-served `identity::*` + `identity.storage::*` overlay for managed-identity clients
//   - a gated `hello::greeter` service (`hello` + `farewell`)
//
// Usage: node ts_gated_hub.mjs <socket-path>
// Prints a single JSON readiness line to stdout and shuts down cleanly when stdin closes.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");
const linkrpcDist = join(repoRoot, "typescript", "packages", "linkrpc", "dist", "index.js");
const hubDist = join(repoRoot, "typescript", "packages", "linkrpc-hub", "dist", "index.js");
const hubServerDist = join(repoRoot, "typescript", "packages", "linkrpc-hub", "dist", "hub", "server", "index.js");
const hubNodeDist = join(repoRoot, "typescript", "packages", "linkrpc-hub", "dist", "hub", "server", "node", "index.js");

const linkrpc = await import(pathToFileURL(linkrpcDist).href);
const hubPkg = await import(pathToFileURL(hubDist).href);
const hubServer = await import(pathToFileURL(hubServerDist).href);
const hubNode = await import(pathToFileURL(hubNodeDist).href);
const { z } = createRequire(linkrpcDist)("zod");

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("usage: node ts_gated_hub.mjs <socket-path>");
  process.exit(2);
}

const {
  InMemoryManagedIdentityStorage,
  TransportPair,
  createSeededMemoryPrincipal,
  createSeededSigningIdentity,
  defineInterface,
  requestType,
} = linkrpc;
const { HubAccessGrantSigner, createHubAccessConfig } = hubPkg;
const {
  Hub,
  RootOverlay,
  createHubServiceInterfaces,
  hubRegisterServiceId,
  registerHubAccessService,
  registerHubServices,
  registerIdentityServices,
  withForwardedCallGate,
  withVerifiedSignature,
} = hubServer;
const { SocketServer } = hubNode;

const greeterInterface = defineInterface(
  { id: "greeter", description: "Greets and bids farewell by name." },
  {
    hello: requestType(
      z.object({ name: z.string() }),
      z.object({ greeting: z.string() }),
    ),
    farewell: requestType(
      z.object({ name: z.string() }),
      z.object({ bye: z.string() }),
    ),
  },
);

const issuer = await createSeededSigningIdentity({ seed: 1 });
const managedPrincipal = await createSeededMemoryPrincipal({ seed: 2 });
const managedStorage = new InMemoryManagedIdentityStorage();

const hub = new Hub();
createHubServiceInterfaces(hub);
const svc = hubRegisterServiceId(hub, "hello");
svc.connection.register(
  greeterInterface,
  {
    hello: ({ name }) => ({ greeting: `Hello, ${name}!` }),
    farewell: ({ name }) => ({ bye: `Goodbye, ${name}!` }),
  },
  { serviceId: "hello" },
);

const grantSigner = new HubAccessGrantSigner(issuer, (ctx) => {
  const requestsForbidden = ctx.permissions.some((p) => {
    const sid = p.target.serviceId;
    return ("exact" in sid && sid.exact === "forbidden") || ("prefix" in sid && sid.prefix === "forbidden");
  });
  if (requestsForbidden) {
    return { result: "rejected", reason: "forbidden service denied by policy" };
  }
  return { result: "permitted" };
});
const hubAccess = createHubAccessConfig(grantSigner.decide);

const server = await SocketServer.start({ endpoint: socketPath });
server.setConnectionHandler((socketTransport) => {
  const hubPair = new TransportPair();
  const hubFacing = withForwardedCallGate(hubPair.b, {
    requireCapability: true,
    acceptedRootIssuers: () => [
      { principal: issuer.publicSigningIdentity.principal, isPublic: true },
    ],
  });
  const upstream = hub.attach(hubFacing);
  const overlay = new RootOverlay({ uplink: hubPair.a });
  registerHubServices(overlay.root, upstream, { hubServiceId: "hub" });
  registerHubAccessService(overlay.root, hubAccess);
  registerIdentityServices(overlay.root, {
    resolveIdentity: async () => managedPrincipal.identity,
    storage: managedStorage,
  });
  overlay.connectParticipant(
    withVerifiedSignature(socketTransport, { verifySignatures: true }),
  );
  socketTransport.onDidClose(() => {
    overlay.dispose();
    upstream.dispose();
  });
});

process.stdout.write(
  JSON.stringify({
    ready: true,
    endpoint: `unix:${socketPath}`,
    issuer: issuer.publicSigningIdentity.principal,
    managedPrincipal: managedPrincipal.id,
  }) + "\n",
);

// Keep alive until parent closes stdin.
process.stdin.resume();
process.stdin.on("end", () => {
  svc.dispose();
  server.dispose();
  process.exit(0);
});
