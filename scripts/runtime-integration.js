import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "mihomo-runtime-test-"));
const candidates = [
  process.env.MIHOMO_BIN,
  "/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo",
  ...String(process.env.PATH ?? "").split(delimiter).map((entry) => join(entry, "mihomo")),
].filter(Boolean);
const mihomo = candidates.find((candidate) => existsSync(candidate));
if (!mihomo) throw new Error("Mihomo not found; set MIHOMO_BIN=/absolute/path/to/mihomo");

const results = [];
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const record = (name, detail) => {
  results.push({ name, detail });
  console.log(`PASS ${name}: ${detail}`);
};

function run(args, options = {}) {
  const result = spawnSync(mihomo, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`mihomo ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function convertMrs(name, domains, directory = tempRoot) {
  mkdirSync(directory, { recursive: true });
  const source = join(directory, `${name}.yaml`);
  const target = join(directory, `${name}.mrs`);
  writeFileSync(source, `payload:\n${domains.map((domain) => `  - "+.${domain}"`).join("\n")}\n`);
  run(["convert-ruleset", "domain", "yaml", source, target]);
  return target;
}

function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startHttpServer(host, handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, host, () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForApi(port, process, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Mihomo exited before API became ready (${process.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`);
      if (response.ok) return response.json();
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for Mihomo API");
}

function startMihomo(home, config, apiPort) {
  mkdirSync(home, { recursive: true });
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, config);
  const child = spawn(mihomo, ["-d", home, "-f", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  return {
    child,
    getLogs: () => logs,
    ready: async () => {
      try {
        return await waitForApi(apiPort, child);
      } catch (error) {
        throw new Error(`${error.message}\n${logs}`);
      }
    },
  };
}

async function stopMihomo(instance) {
  if (instance.child.exitCode !== null) return;
  instance.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => instance.child.once("exit", resolve)),
    delay(3000).then(() => instance.child.kill("SIGKILL")),
  ]);
}

function proxyRequest(proxyPort, hostname, targetPort, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(proxyPort, "127.0.0.1");
    let response = "";
    socket.setTimeout(timeout);
    socket.once("connect", () => {
      socket.write(`GET http://${hostname}:${targetPort}/ HTTP/1.1\r\nHost: ${hostname}:${targetPort}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("timeout", () => socket.destroy(new Error(`proxy request to ${hostname} timed out`)));
    socket.once("error", reject);
  });
}

function runtimeConfig({ mixedPort, apiPort, providers, rules, hosts }) {
  const providerYaml = Object.entries(providers).map(([name, provider]) => `  ${name}:\n    type: ${provider.type}\n    behavior: domain\n    format: mrs\n    path: ${provider.path}${provider.url ? `\n    url: ${provider.url}\n    interval: 1` : ""}${provider.proxy ? `\n    proxy: ${provider.proxy}` : ""}`).join("\n");
  const hostYaml = Object.entries(hosts).map(([name, address]) => `  \"${name}\": \"${address}\"`).join("\n");
  return `mixed-port: ${mixedPort}\nexternal-controller: 127.0.0.1:${apiPort}\nlog-level: debug\nmode: rule\nipv6: true\nhosts:\n${hostYaml}\nproxy-groups:\n  - name: AdBlock\n    type: select\n    proxies: [REJECT, DIRECT]\n  - name: AI\n    type: select\n    proxies: [DIRECT]\n  - name: Domestic\n    type: select\n    proxies: [DIRECT]\n  - name: Google\n    type: select\n    proxies: [AI, DIRECT]\n  - name: GitHub\n    type: select\n    proxies: [AI, DIRECT]\n  - name: Microsoft\n    type: select\n    proxies: [AI, DIRECT]\nrule-providers:\n${providerYaml}\nrules:\n${rules.map((rule) => `  - ${rule}`).join("\n")}\n`;
}

async function validateRemoteMrs() {
  const override = readFileSync(join(root, "mihomo-override_full.yaml"), "utf8");
  const blocks = override.match(/^rule-providers:\n([\s\S]*?)^rules:/mu)?.[1] ?? "";
  const providers = [];
  let current;
  for (const line of blocks.split("\n")) {
    const name = line.match(/^  ([^:]+):$/u)?.[1];
    if (name) {
      current = { name };
      providers.push(current);
    } else if (current) {
      current.behavior ??= line.match(/^    behavior: (domain|ipcidr)$/u)?.[1];
      current.url ??= line.match(/^    url: (https?:\/\/.+)$/u)?.[1];
      current.format ??= line.match(/^    format: (\S+)$/u)?.[1];
    }
  }
  const remote = providers.filter((provider) => provider.url && provider.format === "mrs");
  assert(remote.length >= 20, `expected many remote MRS providers, found ${remote.length}`);
  const domainOwners = new Map();
  for (const provider of remote) {
    const response = await fetch(provider.url, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, `${provider.name} download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length > 8, `${provider.name} returned an empty/truncated response`);
    const input = join(tempRoot, `remote-${provider.name}.mrs`);
    const output = join(tempRoot, `remote-${provider.name}.yaml`);
    writeFileSync(input, bytes);
    run(["convert-ruleset", provider.behavior, "mrs", input, output]);
    const decoded = readFileSync(output, "utf8").trim();
    assert(decoded.length > 0 && decoded.split("\n").every((line) => line.trim().length > 0), `${provider.name} did not decode as MRS`);
    if (provider.behavior === "domain") {
      for (const pattern of decoded.split("\n")) {
        const owners = domainOwners.get(pattern) ?? new Set();
        owners.add(provider.name);
        domainOwners.set(pattern, owners);
      }
    }
  }
  const overlaps = [...domainOwners.values()].filter((owners) => owners.size > 1);
  assert(overlaps.length > 0, "no overlap was found across downloaded domain providers");
  record("remote-mrs", `${remote.length} gh-proxy providers downloaded and decoded by Mihomo`);
  record("remote-overlap-audit", `${overlaps.length} exact domain patterns occur in more than one remote provider`);
}

async function validateRuleOrderAndIpv6() {
  const home = join(tempRoot, "rule-order");
  const rulesetDirectory = join(home, "ruleset");
  const ads = convertMrs("ads", ["overlap.test", "ads-only.test"], rulesetDirectory);
  const aiServices = ["chatgpt.com", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "cursor.com"];
  const ai = convertMrs("ai", ["overlap.test", "ai-only.test", ...aiServices], rulesetDirectory);
  const cn = convertMrs("cn", ["overlap.test", "cn-only.test"], rulesetDirectory);
  let ipv6Family;
  const target = await startHttpServer("::1", (request, response) => {
    ipv6Family = request.socket.remoteFamily;
    response.end("ipv6-ok");
  });
  const targetPort = target.address().port;
  const mixedPort = await freePort();
  const apiPort = await freePort();
  const config = runtimeConfig({
    mixedPort,
    apiPort,
    providers: {
      ads: { type: "file", path: ads },
      ai: { type: "file", path: ai },
      cn: { type: "file", path: cn },
    },
    rules: [
      "RULE-SET,ads,AdBlock",
      "RULE-SET,ai,AI",
      "RULE-SET,cn,Domestic",
      "DOMAIN,accounts.google.com,Google",
      "DOMAIN,github.com,GitHub",
      "DOMAIN,login.microsoftonline.com,Microsoft",
      "MATCH,DIRECT",
    ],
    hosts: {
      "overlap.test": "::1",
      "ai-only.test": "::1",
      "cn-only.test": "::1",
      "ipv6-only.test": "::1",
      "chatgpt.com": "::1",
      "claude.ai": "::1",
      "gemini.google.com": "::1",
      "copilot.microsoft.com": "::1",
      "cursor.com": "::1",
      "accounts.google.com": "::1",
      "github.com": "::1",
      "login.microsoftonline.com": "::1",
    },
  });
  const instance = startMihomo(home, config, apiPort);
  try {
    const version = await instance.ready();
    const rulesResponse = await fetch(`http://127.0.0.1:${apiPort}/rules`);
    const apiRules = await rulesResponse.json();
    assert(rulesResponse.ok && Array.isArray(apiRules.rules), "Mihomo /rules API did not return rules");
    assert(apiRules.rules.slice(0, 3).map((rule) => rule.payload).join(",") === "ads,ai,cn", "Mihomo API rule order differs from config");
    const authGroups = {};
    for (const group of ["Google", "GitHub", "Microsoft"]) {
      const response = await fetch(`http://127.0.0.1:${apiPort}/proxies/${group}`);
      authGroups[group] = await response.json();
      assert(response.ok && authGroups[group].now === "AI", `${group} did not select AI through the API`);
    }

    await proxyRequest(mixedPort, "overlap.test", targetPort).catch(() => "rejected");
    await proxyRequest(mixedPort, "ai-only.test", targetPort);
    await proxyRequest(mixedPort, "cn-only.test", targetPort);
    for (const domain of aiServices) await proxyRequest(mixedPort, domain, targetPort);
    for (const domain of ["accounts.google.com", "github.com", "login.microsoftonline.com"]) {
      await proxyRequest(mixedPort, domain, targetPort);
    }
    const ipv6Response = await proxyRequest(mixedPort, "ipv6-only.test", targetPort);
    await delay(300);
    const logs = instance.getLogs();
    assert(/overlap\.test.*match RuleSet\(ads\).*using AdBlock/u.test(logs), "overlap domain did not first match ads -> AdBlock");
    assert(/ai-only\.test.*match RuleSet\(ai\).*using AI/u.test(logs), "AI domain did not match ai -> AI");
    assert(/cn-only\.test.*match RuleSet\(cn\).*using Domestic/u.test(logs), "CN domain did not match cn -> Domestic");
    for (const domain of aiServices) {
      const escaped = domain.replaceAll(".", "\\.");
      assert(new RegExp(`${escaped}.*match RuleSet\\(ai\\).*using AI`, "u").test(logs), `${domain} did not match ai -> AI`);
    }
    assert(/accounts\.google\.com.*match Domain.*using Google/u.test(logs), "Gemini authentication did not route through Google");
    assert(/github\.com.*match Domain.*using GitHub/u.test(logs), "Copilot authentication did not route through GitHub");
    assert(/login\.microsoftonline\.com.*match Domain.*using Microsoft/u.test(logs), "Microsoft authentication did not route through Microsoft");
    assert(ipv6Response.includes("ipv6-ok") && ipv6Family === "IPv6", "IPv6-only host did not use an IPv6 connection");
    record("mihomo-api-log", `${version.version ?? "Mihomo"} API order and runtime log matches verified`);
    record("provider-overlap", "ads wins over AI and CN for an intentionally overlapping domain");
    record("ai-service-routing", `${aiServices.join(", ")} matched AI in Mihomo runtime logs`);
    record("ai-auth-inheritance", "Google, GitHub, and Microsoft authentication groups inherited the AI exit");
    record("ipv6-loopback", "domain resolved only to ::1 and completed through an IPv6 socket");
  } finally {
    await stopMihomo(instance);
    await closeServer(target);
  }
}

async function validateProviderCache() {
  const cachedMrs = readFileSync(convertMrs("cached-source", ["cached.test"]));
  let providerRequests = 0;
  const providerServer = await startHttpServer("127.0.0.1", (_request, response) => {
    providerRequests += 1;
    response.setHeader("Content-Type", "application/octet-stream");
    response.end(cachedMrs);
  });
  const providerPort = providerServer.address().port;
  const mixedPort = await freePort();
  const apiPort = await freePort();
  const home = join(tempRoot, "provider-cache");
  mkdirSync(join(home, "ruleset"), { recursive: true });
  const config = runtimeConfig({
    mixedPort,
    apiPort,
    providers: {
      cached: { type: "http", path: "./ruleset/cached.mrs", url: `http://127.0.0.1:${providerPort}/cached.mrs`, proxy: "DIRECT" },
    },
    rules: ["RULE-SET,cached,AI", "MATCH,REJECT"],
    hosts: { "cached.test": "::1" },
  });
  const first = startMihomo(home, config, apiPort);
  const cachePath = join(home, "ruleset", "cached.mrs");
  try {
    await first.ready();
    const deadline = Date.now() + 10000;
    while ((!existsSync(cachePath) || providerRequests === 0) && Date.now() < deadline) await delay(100);
  } finally {
    await stopMihomo(first);
    await closeServer(providerServer);
  }
  assert(
    existsSync(cachePath) && providerRequests > 0,
    `provider cache was not populated (requests=${providerRequests}, exists=${existsSync(cachePath)})\n${first.getLogs()}`,
  );
  await delay(1200);

  const secondApiPort = await freePort();
  const secondMixedPort = await freePort();
  const offlineConfig = config
    .replace(`mixed-port: ${mixedPort}`, `mixed-port: ${secondMixedPort}`)
    .replace(`external-controller: 127.0.0.1:${apiPort}`, `external-controller: 127.0.0.1:${secondApiPort}`);
  const second = startMihomo(home, offlineConfig, secondApiPort);
  try {
    await second.ready();
    await delay(1500);
    const rulesResponse = await fetch(`http://127.0.0.1:${secondApiPort}/rules`);
    const apiRules = await rulesResponse.json();
    assert(apiRules.rules?.some((rule) => rule.payload === "cached"), "cached provider missing after offline restart");
    assert(
      /cached not updated for a long time/iu.test(second.getLogs()) && /connection refused/iu.test(second.getLogs()),
      `offline provider update failure was not logged\n${second.getLogs()}`,
    );
    record("provider-cache", "cached MRS loaded after provider became unreachable; refresh failure logged");
  } finally {
    await stopMihomo(second);
  }

  const emptyHome = join(tempRoot, "provider-no-cache");
  mkdirSync(join(emptyHome, "ruleset"), { recursive: true });
  const emptyApiPort = await freePort();
  const emptyMixedPort = await freePort();
  const emptyConfig = config
    .replace(`mixed-port: ${mixedPort}`, `mixed-port: ${emptyMixedPort}`)
    .replace(`external-controller: 127.0.0.1:${apiPort}`, `external-controller: 127.0.0.1:${emptyApiPort}`);
  const empty = startMihomo(emptyHome, emptyConfig, emptyApiPort);
  let unsafeDirectHits = 0;
  const failClosedTarget = await startHttpServer("::1", (_request, response) => {
    unsafeDirectHits += 1;
    response.end("unexpected-direct");
  });
  try {
    await empty.ready();
    await delay(500);
    await proxyRequest(emptyMixedPort, "cached.test", failClosedTarget.address().port, 2000).catch(() => "rejected");
    await delay(200);
    const logs = empty.getLogs();
    assert(/Start initial provider cached/iu.test(logs) && /connection refused/iu.test(logs), `missing-cache provider failure was not logged\n${logs}`);
    assert(unsafeDirectHits === 0, `missing cache allowed ${unsafeDirectHits} direct request(s)`);
    record("provider-no-cache", "download failure was logged and the protected request never reached a DIRECT target");
  } finally {
    await stopMihomo(empty);
    await closeServer(failClosedTarget);
  }
}

let runtimeFailure;
try {
  const version = run(["-v"]).stdout.trim();
  console.log(`Using ${version}`);
  await validateRemoteMrs();
  await validateRuleOrderAndIpv6();
  await validateProviderCache();
  console.log(`Runtime integration passed (${results.length} checks)`);
} catch (error) {
  runtimeFailure = error;
} finally {
  await delay(500);
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (cleanupError) {
    if (!runtimeFailure) runtimeFailure = cleanupError;
  }
}
if (runtimeFailure) throw runtimeFailure;
