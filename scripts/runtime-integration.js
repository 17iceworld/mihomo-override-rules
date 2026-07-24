import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
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

function freeUdpPort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, host, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
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

function decodeDnsQuestion(message) {
  const labels = [];
  let offset = 12;
  while (offset < message.length && message[offset] !== 0) {
    const length = message[offset];
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString("ascii"));
    offset += length + 1;
  }
  if (offset + 5 > message.length) throw new Error("Malformed DNS question");
  return { domain: labels.join("."), questionEnd: offset + 5 };
}

function startDnsServer() {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const queries = [];
    socket.once("error", reject);
    socket.on("message", (message, remote) => {
      const { domain, questionEnd } = decodeDnsQuestion(message);
      queries.push(domain);
      const header = Buffer.alloc(12);
      message.copy(header, 0, 0, 2);
      header.writeUInt16BE(0x8180, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(1, 6);
      const answer = Buffer.from([
        0xc0, 0x0c,
        0x00, 0x01,
        0x00, 0x01,
        0x00, 0x00, 0x00, 0x3c,
        0x00, 0x04,
        127, 0, 0, 1,
      ]);
      socket.send(Buffer.concat([header, message.subarray(12, questionEnd), answer]), remote.port, remote.address);
    });
    socket.bind(0, "127.0.0.1", () => resolve({
      socket,
      port: socket.address().port,
      queries,
    }));
  });
}

function closeDnsServer(server) {
  return new Promise((resolve) => server.socket.close(resolve));
}

function dnsQuery(port, domain, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const id = Math.floor(Math.random() * 0xffff);
    const labels = domain.split(".").map((label) => {
      const bytes = Buffer.from(label, "ascii");
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const question = Buffer.concat([
      ...labels,
      Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]),
    ]);
    const timer = setTimeout(() => socket.close(() => reject(new Error(`DNS query for ${domain} timed out`))), timeout);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close(() => reject(error));
    });
    socket.once("message", (message) => {
      clearTimeout(timer);
      socket.close(() => {
        if (message.readUInt16BE(0) !== id || message.readUInt16BE(6) < 1) {
          reject(new Error(`DNS query for ${domain} returned an invalid response`));
        } else {
          resolve();
        }
      });
    });
    socket.send(Buffer.concat([header, question]), port, "127.0.0.1");
  });
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

async function validateAnime1NodeFiltering() {
  const home = join(tempRoot, "anime1-node-filtering");
  const apiPort = await freePort();
  const japaneseNodes = [
    "JP-01",
    "JPN Premium",
    "Japan 01",
    "🇯🇵 Tokyo",
    "日本",
    "大阪-01",
    "Nagoya 01",
    "Fukuoka 01",
    "Sapporo 01",
    "Okinawa 01",
  ];
  const nonJapaneseNodes = [
    "HK-01",
    "TW 台灣",
    "SG Singapore",
    "US Los Angeles",
  ];
  const proxies = [...japaneseNodes, ...nonJapaneseNodes]
    .map((name, index) => `  - name: "${name}"\n    type: http\n    server: 192.0.2.${index + 1}\n    port: 443`)
    .join("\n");
  const config = `external-controller: 127.0.0.1:${apiPort}
log-level: warning
mode: rule
proxies:
${proxies}
proxy-groups:
  - name: Anime1
    type: url-test
    include-all: true
    exclude-filter: "(?i)🇯🇵|日本|東京|大阪|名古屋|福岡|札幌|沖縄|沖繩|JP|JPN|Japan|Tokyo|Osaka|Nagoya|Fukuoka|Sapporo|Okinawa"
    exclude-type: direct
    empty-fallback: REJECT
    url: https://www.gstatic.com/generate_204
    interval: 300
    timeout: 5000
    tolerance: 50
    lazy: true
rules:
  - MATCH,Anime1
`;
  const instance = startMihomo(home, config, apiPort);
  try {
    await instance.ready();
    const response = await fetch(`http://127.0.0.1:${apiPort}/proxies/Anime1`);
    const group = await response.json();
    assert(response.ok && Array.isArray(group.all), "Anime1 proxy group was not exposed through the Mihomo API");
    for (const node of japaneseNodes) {
      assert(!group.all.includes(node), `Anime1 unexpectedly retained Japanese node ${node}`);
    }
    for (const node of nonJapaneseNodes) {
      assert(group.all.includes(node), `Anime1 unexpectedly excluded non-Japanese node ${node}`);
    }
    assert(
      group.all.length === nonJapaneseNodes.length,
      `Anime1 exposed unexpected candidates: ${group.all.join(", ")}`,
    );
    record("anime1-node-filtering", `${japaneseNodes.length} Japanese labels excluded; ${nonJapaneseNodes.length} non-Japanese nodes retained`);
  } finally {
    await stopMihomo(instance);
  }
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
  const providerPatterns = new Map();
  let current;
  for (const line of blocks.split("\n")) {
    const name = line.match(/^  (\S[^:]*):$/u)?.[1];
    if (name) {
      current = { name, patterns: [] };
      providers.push(current);
    } else if (current) {
      current.behavior ??= line.match(/^    behavior: (domain|ipcidr)$/u)?.[1];
      current.url ??= line.match(/^    url: (https?:\/\/.+)$/u)?.[1];
      current.format ??= line.match(/^    format: (\S+)$/u)?.[1];
      const inlinePattern = line.match(/^      - "([^"]+)"$/u)?.[1];
      if (inlinePattern) current.patterns.push(inlinePattern);
    }
  }
  for (const provider of providers) {
    if (provider.behavior === "domain" && provider.patterns.length > 0) {
      providerPatterns.set(provider.name, provider.patterns);
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
      const patterns = decoded.split("\n");
      providerPatterns.set(provider.name, patterns);
      for (const pattern of patterns) {
        const owners = domainOwners.get(pattern) ?? new Set();
        owners.add(provider.name);
        domainOwners.set(pattern, owners);
      }
    }
  }
  const overlaps = [...domainOwners.values()].filter((owners) => owners.size > 1);
  assert(overlaps.length > 0, "no overlap was found across downloaded domain providers");

  function domainMatches(pattern, domain) {
    if (pattern.startsWith("regexp:")) return new RegExp(pattern.slice(7), "u").test(domain);
    if (pattern.startsWith("keyword:")) return domain.includes(pattern.slice(8));
    if (pattern.startsWith("*.")) return domain.endsWith(pattern.slice(1)) && domain !== pattern.slice(2);
    if (pattern.startsWith("+.") || pattern.startsWith(".")) {
      const suffix = pattern.startsWith("+.") ? pattern.slice(2) : pattern.slice(1);
      return domain === suffix || domain.endsWith(`.${suffix}`);
    }
    return domain === pattern;
  }

  const orderedProviders = [...override.matchAll(/^  - RULE-SET,([^,]+),([^,\n]+)/gmu)]
    .map((match) => ({ provider: match[1], outbound: match[2] }));
  const casesSource = readFileSync(join(root, "tests/cases.yaml"), "utf8");
  let checkedCases = 0;
  for (const block of casesSource.split(/\n(?=  - domain: )/u)) {
    const domain = block.match(/domain: "([^"]+)"/u)?.[1];
    const expectedProvider = block.match(/provider: "([^"]+)"/u)?.[1];
    const expectedOutbound = block.match(/outbound: "([^"]+)"/u)?.[1];
    if (!domain || !expectedProvider || !expectedOutbound) continue;
    const firstMatch = orderedProviders.find(({ provider }) =>
      (providerPatterns.get(provider) ?? []).some((pattern) => domainMatches(pattern, domain))
    );
    assert(firstMatch, `${domain} did not match any downloaded or inline domain provider`);
    assert(
      firstMatch.provider === expectedProvider && firstMatch.outbound === expectedOutbound,
      `${domain} first matched ${firstMatch.provider} -> ${firstMatch.outbound}, expected ${expectedProvider} -> ${expectedOutbound}`,
    );
    checkedCases += 1;
  }
  record("remote-mrs", `${remote.length} gh-proxy providers downloaded and decoded by Mihomo`);
  record("remote-overlap-audit", `${overlaps.length} exact domain patterns occur in more than one remote provider`);
  record("full-profile-cases", `${checkedCases} domains matched the first expected inline or downloaded provider`);
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

async function validateDnsPolicyRouting() {
  const directDns = await startDnsServer();
  const proxyDns = await startDnsServer();
  const dnsPort = await freeUdpPort();
  const apiPort = await freePort();
  const home = join(tempRoot, "dns-policy-routing");
  const directUrl = `udp://127.0.0.1:${directDns.port}#DIRECT`;
  const proxyUrl = `udp://127.0.0.1:${proxyDns.port}#PROXY`;
  const config = `external-controller: 127.0.0.1:${apiPort}
log-level: debug
mode: rule
proxy-groups:
  - name: PROXY
    type: select
    proxies: [DIRECT]
rule-providers:
  ai:
    type: inline
    behavior: domain
    payload:
      - "+.copilot.microsoft.com"
  microsoft:
    type: inline
    behavior: domain
    payload:
      - "+.microsoft.com"
  onedrive:
    type: inline
    behavior: domain
    payload:
      - "+.onedrive.live.com"
dns:
  enable: true
  listen: 127.0.0.1:${dnsPort}
  enhanced-mode: redir-host
  prefer-h3: false
  respect-rules: true
  default-nameserver:
    - ${directUrl}
  proxy-server-nameserver:
    - ${directUrl}
  nameserver:
    - ${proxyUrl}
  nameserver-policy:
    "rule-set:ai":
      - ${proxyUrl}
    "rule-set:microsoft":
      - ${directUrl}
    "rule-set:onedrive":
      - ${directUrl}
rules:
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
  - RULE-SET,ai,PROXY
  - RULE-SET,microsoft,PROXY
  - RULE-SET,onedrive,PROXY
  - MATCH,PROXY
`;
  const instance = startMihomo(home, config, apiPort);
  try {
    await instance.ready();
    for (const domain of ["microsoft.com", "onedrive.live.com", "copilot.microsoft.com", "example.net"]) {
      await dnsQuery(dnsPort, domain);
    }
    await delay(200);
    const directExpected = ["microsoft.com", "onedrive.live.com"];
    const proxyExpected = ["copilot.microsoft.com", "example.net"];
    for (const domain of directExpected) {
      assert(directDns.queries.includes(domain), `${domain} did not use the direct DNS policy`);
      assert(!proxyDns.queries.includes(domain), `${domain} unexpectedly reached the proxy DNS policy`);
    }
    for (const domain of proxyExpected) {
      assert(proxyDns.queries.includes(domain), `${domain} did not use the proxy DNS policy`);
      assert(!directDns.queries.includes(domain), `${domain} unexpectedly reached the direct DNS policy`);
    }
    record(
      "dns-policy-routing",
      "Microsoft and OneDrive used direct DNS; Copilot overlap and default global queries used proxy DNS",
    );
  } finally {
    await stopMihomo(instance);
    await closeDnsServer(directDns);
    await closeDnsServer(proxyDns);
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
  await validateAnime1NodeFiltering();
  await validateRemoteMrs();
  await validateRuleOrderAndIpv6();
  await validateDnsPolicyRouting();
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
