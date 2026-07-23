import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleFiles = [
  "modules/dns.yaml",
  "modules/proxy-groups.yaml",
  "modules/rule-providers.yaml",
  "modules/rules.yaml",
];
const profiles = [
  {
    name: "light",
    outputFile: "mihomo-override.yaml",
    moduleFiles,
  },
  {
    name: "full",
    outputFile: "mihomo-override_full.yaml",
    moduleFiles: [
      "modules/full-dns.yaml",
      "modules/full-proxy-groups.yaml",
      "modules/full-rule-providers.yaml",
      "modules/full-rules.yaml",
    ],
  },
];
const rawGitHubPrefix = "https://raw.githubusercontent.com/";
const ghProxyPrefix = "https://gh-proxy.org/";
const jsDelivrPrefix = "https://cdn.jsdelivr.net/gh/";
const ruleMirror = process.env.RULE_MIRROR ?? "gh-proxy";

function readText(file) {
  return readFileSync(resolve(root, file), "utf8").replace(/\s+$/u, "");
}

function topLevelKeys(source) {
  return [...source.matchAll(/^([A-Za-z0-9_-]+):/gmu)].map((match) => match[1]);
}

function expandPayloadFrom(source) {
  return source.replace(/^(\s*)payload-from: (.+)$/gmu, (_match, indent, file) => {
    const payload = readText(file.trim());
    if (!payload.startsWith("payload:\n")) {
      throw new Error(`${file} must start with "payload:"`);
    }
    return payload
      .split("\n")
      .map((line) => `${indent}${line}`)
      .join("\n");
  });
}

function ruleProviderBlocks(output) {
  const providersSection = output.match(/^rule-providers:\n([\s\S]*?)(?=^sub-rules:|^rules:)/mu)?.[1] ?? "";
  const blocks = new Map();
  let currentProvider = null;
  let currentBlock = [];

  for (const line of providersSection.split("\n")) {
    const providerMatch = line.match(/^  (\S[^:\n]*):$/u);
    if (providerMatch) {
      if (currentProvider) {
        blocks.set(currentProvider, `${currentBlock.join("\n")}\n`);
      }
      currentProvider = providerMatch[1];
      currentBlock = [];
      continue;
    }
    if (currentProvider) {
      currentBlock.push(line);
    }
  }

  if (currentProvider) {
    blocks.set(currentProvider, `${currentBlock.join("\n")}\n`);
  }

  return blocks;
}

function mirroredRemoteUrls(source) {
  if (ruleMirror === "direct") return source;
  if (ruleMirror === "gh-proxy") {
    return source.replaceAll(`url: ${rawGitHubPrefix}`, `url: ${ghProxyPrefix}${rawGitHubPrefix}`);
  }
  if (ruleMirror === "jsdelivr") {
    return source.replaceAll(
      /url: https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/gu,
      `url: ${jsDelivrPrefix}$1/$2@$3/$4`,
    );
  }
  throw new Error(`Unsupported RULE_MIRROR "${ruleMirror}"; use direct, gh-proxy, or jsdelivr`);
}

function validateModules(files) {
  const seenTopLevelKeys = new Map();
  for (const file of files) {
    const source = readText(file);
    if (source.includes("\t")) {
      throw new Error(`${file} contains tabs; use spaces for YAML indentation`);
    }
    for (const key of topLevelKeys(source)) {
      if (seenTopLevelKeys.has(key)) {
        throw new Error(`Duplicate top-level key "${key}" in ${file} and ${seenTopLevelKeys.get(key)}`);
      }
      seenTopLevelKeys.set(key, file);
    }
  }
}

function validateReferences(output, profileName) {
  const requiredRuleProviders = new Set();
  const providerBlocks = ruleProviderBlocks(output);
  const availableRuleProviders = new Set(providerBlocks.keys());
  const availableGroups = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

  for (const match of output.matchAll(/^  - name: ([^\n]+)/gmu)) {
    availableGroups.add(match[1].trim().replace(/^["']|["']$/gu, ""));
  }

  for (const match of output.matchAll(/^  - ([A-Z-]+,[^\n]+)/gmu)) {
    const rule = match[1].trim();
    const [type, provider, outbound] = rule.split(",");
    if (type === "RULE-SET") {
      requiredRuleProviders.add(provider);
      if (!availableGroups.has(outbound)) {
        throw new Error(`Rule references unknown outbound group: ${rule}`);
      }
    }
    if (type === "GEOIP" && !availableGroups.has(outbound)) {
      throw new Error(`GEOIP references unknown outbound group: ${rule}`);
    }
    if (type === "MATCH" && !availableGroups.has(provider)) {
      throw new Error(`MATCH references unknown outbound group: ${rule}`);
    }
  }

  for (const provider of requiredRuleProviders) {
    if (!availableRuleProviders.has(provider)) {
      throw new Error(`Rule references missing rule-provider: ${provider}`);
    }
  }

  const requiredHttpFields = ["type", "behavior", "format", "path", "url", "interval"];
  for (const [provider, block] of providerBlocks) {
    if (!/^    type: http$/mu.test(block)) {
      continue;
    }
    for (const field of requiredHttpFields) {
      if (!new RegExp(`^    ${field}:`, "mu").test(block)) {
        throw new Error(`${profileName}: HTTP rule-provider "${provider}" is missing required field: ${field}`);
      }
    }
  }
}

function validateRuleSafety(output, profileName) {
  const rules = [...output.matchAll(/^  - ([A-Z-]+,[^\n]+)$/gmu)].map((match) => match[1].trim());
  const duplicates = rules.filter((rule, index) => rules.indexOf(rule) !== index);
  if (duplicates.length > 0) {
    throw new Error(`${profileName}: duplicate rules: ${[...new Set(duplicates)].join(", ")}`);
  }

  const matches = rules.filter((rule) => rule.startsWith("MATCH,"));
  if (matches.length !== 1 || !rules.at(-1)?.startsWith("MATCH,")) {
    throw new Error(`${profileName}: rules must contain exactly one final MATCH rule`);
  }

  const providerBlocks = ruleProviderBlocks(output);
  for (const rule of rules) {
    const [type, provider, _outbound, ...options] = rule.split(",");
    const isIpRule = type === "GEOIP" || type === "IP-CIDR" || type === "IP-CIDR6";
    const isIpProvider = type === "RULE-SET"
      && /^    behavior: ipcidr$/mu.test(providerBlocks.get(provider) ?? "");
    if ((isIpRule || isIpProvider) && !options.includes("no-resolve")) {
      throw new Error(`${profileName}: IP rule must use no-resolve: ${rule}`);
    }
  }
}

function validateParsecRouting(output, profileName) {
  if (!/^find-process-mode: strict$/mu.test(output)) {
    throw new Error(`${profileName}: Parsec routing requires find-process-mode: strict`);
  }

  const providerBlocks = ruleProviderBlocks(output);
  for (const provider of ["private-ip", "cn-ip"]) {
    if (!providerBlocks.has(provider)) {
      throw new Error(`${profileName}: Parsec routing references missing provider ${provider}`);
    }
  }

  const subRulesSection = output.match(/^sub-rules:\n([\s\S]*?)^rules:/mu)?.[1] ?? "";
  const parsecBlock = subRulesSection.match(/^  parsec-routing:\n((?:    - .+\n?)*)/mu)?.[1] ?? "";
  const parsecRules = [...parsecBlock.matchAll(/^    - (.+)$/gmu)].map((match) => match[1]);
  const expectedParsecRules = [
    "RULE-SET,private-ip,DIRECT,no-resolve",
    "RULE-SET,cn-ip,DIRECT,no-resolve",
    "MATCH,PROXY",
  ];
  if (parsecRules.join("\n") !== expectedParsecRules.join("\n")) {
    throw new Error(
      `${profileName}: parsec-routing must route private/CN IPs directly and all remaining traffic through PROXY`,
    );
  }

  const rules = [...output.matchAll(/^  - ([A-Z-]+,[^\n]+)$/gmu)].map((match) => match[1].trim());
  const directGlobalIndex = rules.indexOf("RULE-SET,direct-global-domain,DIRECT");
  const firstGeneralServiceIndex = rules.indexOf("RULE-SET,category-ads-all,AdBlock");
  const processNames = ["parsecd.exe", "pservice.exe", "parsecd"];
  for (const processName of processNames) {
    const rule = `SUB-RULE,(PROCESS-NAME,${processName}),parsec-routing`;
    const index = rules.indexOf(rule);
    if (index < 0) {
      throw new Error(`${profileName}: missing Parsec process rule ${rule}`);
    }
    if (index < directGlobalIndex || index > firstGeneralServiceIndex) {
      throw new Error(`${profileName}: ${rule} must follow direct exceptions and precede general service rules`);
    }
  }

  const directGlobalDomains = [
    ...(providerBlocks.get("direct-global-domain") ?? "").matchAll(/^      - "([^"]+)"$/gmu),
  ].map((match) => match[1]);
  for (const stunDomain of ["stun.parsec.app", "stun6.parsec.app"]) {
    if (!directGlobalDomains.includes(stunDomain)) {
      throw new Error(`${profileName}: direct-global-domain is missing ${stunDomain}`);
    }
  }

  function domainMatches(pattern, domain) {
    if (pattern.startsWith("*.")) return domain.endsWith(pattern.slice(1)) && domain !== pattern.slice(2);
    if (pattern.startsWith("+.")) return domain === pattern.slice(2) || domain.endsWith(pattern.slice(1));
    if (pattern.startsWith(".")) return domain === pattern.slice(1) || domain.endsWith(pattern);
    return domain === pattern;
  }

  for (const domain of [
    "kessel-ws.parsec.app",
    "kessel-api.parsec.app",
    "builds.parsec.app",
    "public.parsec.app",
    "builds.parsecgaming.com",
    "parsecusercontent.com",
  ]) {
    if (directGlobalDomains.some((pattern) => domainMatches(pattern, domain))) {
      throw new Error(`${profileName}: Parsec control-plane domain ${domain} must not be unconditionally DIRECT`);
    }
  }
}

function validateProxyGroups(output, profileName) {
  const section = output.match(/^proxy-groups:\n([\s\S]*?)^rule-providers:/mu)?.[1] ?? "";
  const blocks = section.split(/(?=^  - name: )/mu).filter((block) => /^  - name: /mu.test(block));
  const groups = new Map();
  for (const block of blocks) {
    const name = block.match(/^  - name: (.+)$/mu)?.[1]?.trim().replace(/^['"]|['"]$/gu, "");
    if (!name) continue;
    if (groups.has(name)) throw new Error(`${profileName}: duplicate proxy group: ${name}`);
    const proxiesBlock = block.match(/^    proxies:\n((?:      - .+\n?)*)/mu)?.[1] ?? "";
    const proxies = [...proxiesBlock.matchAll(/^      - (.+)$/gmu)]
      .map((match) => match[1].trim().replace(/^['"]|['"]$/gu, ""));
    groups.set(name, proxies);
  }

  const builtins = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
  for (const [name, proxies] of groups) {
    for (const proxy of proxies) {
      if (!groups.has(proxy) && !builtins.has(proxy)) {
        throw new Error(`${profileName}: group ${name} references unknown proxy/group: ${proxy}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error(`${profileName}: proxy group cycle includes ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of groups.get(name) ?? []) if (groups.has(child)) visit(child);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of groups.keys()) visit(name);

  for (const name of ["Google", "GitHub", "Microsoft"]) {
    if (groups.has(name) && groups.get(name)?.[0] !== "AI") {
      throw new Error(`${profileName}: ${name} must inherit AI first for authentication exit consistency`);
    }
  }
}

function validateRuleMirror(output, profileName) {
  for (const [provider, block] of ruleProviderBlocks(output)) {
    if (!/^    type: http$/mu.test(block)) continue;
    const url = block.match(/^    url: (https?:\/\/[^\n]+)$/mu)?.[1];
    if (!url) throw new Error(`${profileName}: HTTP rule-provider ${provider} has no URL`);
    if (ruleMirror === "direct" && !url.startsWith(rawGitHubPrefix)) {
      throw new Error(`${profileName}: direct mirror produced unexpected URL for ${provider}: ${url}`);
    }
    if (ruleMirror === "gh-proxy" && !url.startsWith(`${ghProxyPrefix}${rawGitHubPrefix}`)) {
      throw new Error(`${profileName}: gh-proxy mirror produced unexpected URL for ${provider}: ${url}`);
    }
    if (ruleMirror === "jsdelivr" && !url.startsWith(jsDelivrPrefix)) {
      throw new Error(`${profileName}: jsdelivr mirror produced unexpected URL for ${provider}: ${url}`);
    }
  }
}

function validateDnsPolicies(output, profileName) {
  const providerBlocks = ruleProviderBlocks(output);
  const availableRuleProviders = new Set(providerBlocks.keys());

  for (const match of output.matchAll(/^    "rule-set:([^"]+)":\n((?:      - .+\n)+)/gmu)) {
    const provider = match[1];
    const policy = match[2];
    if (!availableRuleProviders.has(provider)) {
      throw new Error(`${profileName}: DNS policy references missing rule-provider: ${provider}`);
    }
    if (provider === "direct-global-domain" && /(alidns\.com|doh\.pub)/u.test(policy)) {
      throw new Error(`${profileName}: direct-global-domain must not use China DNS providers`);
    }
    if (provider === "direct-cn-domain" && /(cloudflare-dns\.com|1\.1\.1\.1)/u.test(policy)) {
      throw new Error(`${profileName}: direct-cn-domain must not use Cloudflare DNS providers`);
    }

    const directDnsProviders = new Set(["private-domain", "apple-cn-domain", "direct-cn-domain", "cn-domain", "geolocation-cn", "apple-cn", "microsoft", "onedrive"]);
    const routes = [...policy.matchAll(/^      - (.+)$/gmu)].map((match) => match[1]);
    const requiredRoute = directDnsProviders.has(provider) ? "#DIRECT" : "#PROXY";
    if (routes.some((route) => !route.endsWith(requiredRoute))) {
      throw new Error(`${profileName}: DNS policy ${provider} must use ${requiredRoute}`);
    }
  }

  const dnsPolicyOrder = [...output.matchAll(/^    "rule-set:([^"]+)":/gmu)]
    .map((match) => match[1]);
  for (const aiProvider of ["ai-domain", "category-ai-!cn", "openai", "anthropic"]) {
    const aiIndex = dnsPolicyOrder.indexOf(aiProvider);
    if (aiIndex < 0) continue;
    for (const microsoftProvider of ["microsoft", "onedrive"]) {
      const microsoftIndex = dnsPolicyOrder.indexOf(microsoftProvider);
      if (microsoftIndex >= 0 && aiIndex > microsoftIndex) {
        throw new Error(
          `${profileName}: DNS policy ${aiProvider} must precede ${microsoftProvider} so overlapping AI domains use #PROXY`,
        );
      }
    }
  }

  if (!/^allow-lan: false$/mu.test(output)) {
    throw new Error(`${profileName}: allow-lan must be false`);
  }
  if (!/^  respect-rules: true$/mu.test(output) || !/^  prefer-h3: false$/mu.test(output)) {
    throw new Error(`${profileName}: DNS must use respect-rules and disable prefer-h3`);
  }
  if (/^proxies:/mu.test(output)) {
    throw new Error(`${profileName}: override must not define or replace subscription proxies`);
  }
  const proxyGroup = output.match(/^  - name: "PROXY"\n([\s\S]*?)(?=^  - name:|^rule-providers:)/mu)?.[1] ?? "";
  if (/^      - DIRECT$/mu.test(proxyGroup)) {
    throw new Error(`${profileName}: PROXY must not allow DIRECT because global DNS uses #PROXY`);
  }

  const defaultNameservers = output.match(/^  default-nameserver:\n((?:    - .+\n)+)/mu)?.[1] ?? "";
  if (!defaultNameservers || /^    - (?!tls:\/\/|https:\/\/)/mu.test(defaultNameservers)) {
    throw new Error(`${profileName}: bootstrap DNS must be encrypted`);
  }

  for (const key of ["nameserver"]) {
    const block = output.match(new RegExp(`^  ${key}:\\n((?:    - .+\\n)+)`, "mu"))?.[1] ?? "";
    if (!block || [...block.matchAll(/^    - (.+)$/gmu)].some((match) => !match[1].endsWith("#PROXY"))) {
      throw new Error(`${profileName}: ${key} must explicitly use #PROXY`);
    }
  }

  for (const key of ["proxy-server-nameserver", "direct-nameserver"]) {
    const block = output.match(new RegExp(`^  ${key}:\\n((?:    - .+\\n)+)`, "mu"))?.[1] ?? "";
    if (!block || [...block.matchAll(/^    - (.+)$/gmu)].some((match) => !match[1].endsWith("#DIRECT"))) {
      throw new Error(`${profileName}: ${key} must explicitly use #DIRECT`);
    }
  }

  const privateIpBlock = providerBlocks.get("private-ip") ?? "";
  for (const cidr of ["::/128", "::1/128", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8"]) {
    if (!privateIpBlock.includes(`- "${cidr}"`)) {
      throw new Error(`${profileName}: inline private-ip is missing IPv6 fallback range ${cidr}`);
    }
  }
}

function validateCases(output) {
  const casesFile = "tests/cases.yaml";
  const source = readText(casesFile);
  const providerBlocks = ruleProviderBlocks(output);
  const orderedProviders = [...output.matchAll(/^  - RULE-SET,([^,]+),([^,\n]+)/gmu)]
    .map((match) => ({ provider: match[1], outbound: match[2] }));

  function inlineDomains(provider) {
    const block = providerBlocks.get(provider) ?? "";
    if (!/^    type: inline$/mu.test(block) || !/^    behavior: domain$/mu.test(block)) return [];
    return [...block.matchAll(/^      - "([^"]+)"$/gmu)].map((match) => match[1]);
  }

  function domainMatches(pattern, domain) {
    if (pattern.startsWith("*.")) return domain.endsWith(pattern.slice(1)) && domain !== pattern.slice(2);
    if (pattern.startsWith("+.")) return domain === pattern.slice(2) || domain.endsWith(pattern.slice(1));
    if (pattern.startsWith(".")) return domain === pattern.slice(1) || domain.endsWith(pattern);
    return domain === pattern;
  }

  for (const block of source.split(/\n(?=  - domain: )/u)) {
    const domain = block.match(/domain: "([^"]+)"/u)?.[1];
    const provider = block.match(/provider: "([^"]+)"/u)?.[1];
    const outbound = block.match(/outbound: "([^"]+)"/u)?.[1];
    if (!domain && !provider && !outbound) {
      continue;
    }
    if (!domain || !provider || !outbound) {
      throw new Error(`${casesFile}: each case must include domain, provider, and outbound`);
    }
    if (!new RegExp(`^  ${provider}:$`, "mu").test(output)) {
      throw new Error(`${casesFile}: case for ${domain} references missing provider ${provider}`);
    }
    if (!output.includes(`RULE-SET,${provider},${outbound}`)) {
      throw new Error(`${casesFile}: case for ${domain} cannot find RULE-SET,${provider},${outbound}`);
    }

    const expectedInlineDomains = inlineDomains(provider);
    if (expectedInlineDomains.length > 0) {
      if (!expectedInlineDomains.some((pattern) => domainMatches(pattern, domain))) {
        throw new Error(`${casesFile}: ${domain} does not match inline provider ${provider}`);
      }
      const firstInlineMatch = orderedProviders.find(({ provider: candidate }) =>
        inlineDomains(candidate).some((pattern) => domainMatches(pattern, domain))
      );
      if (firstInlineMatch?.provider !== provider || firstInlineMatch.outbound !== outbound) {
        throw new Error(
          `${casesFile}: ${domain} first matches ${firstInlineMatch?.provider ?? "no inline provider"}`
          + ` -> ${firstInlineMatch?.outbound ?? "unknown"}, expected ${provider} -> ${outbound}`,
        );
      }
    }
  }
}

function build(profile) {
  validateModules(profile.moduleFiles);
  const header = [
    "# Generated by scripts/build-override.js.",
    "# Edit files under modules/ and rules/ instead.",
    "",
  ].join("\n");
  const output = mirroredRemoteUrls(
    `${header}${profile.moduleFiles.map((file) => expandPayloadFrom(readText(file))).join("\n\n")}\n`,
  );
  validateReferences(output, profile.name);
  validateProxyGroups(output, profile.name);
  validateRuleSafety(output, profile.name);
  validateParsecRouting(output, profile.name);
  validateRuleMirror(output, profile.name);
  validateDnsPolicies(output, profile.name);
  return output;
}

const outputs = new Map();
const checkOnly = process.argv.includes("--check");
for (const profile of profiles) {
  const output = build(profile);
  outputs.set(profile.name, output);
  const outputPath = resolve(root, profile.outputFile);
  if (checkOnly) {
    const existing = readFileSync(outputPath, "utf8");
    if (existing !== output) {
      throw new Error(`${profile.outputFile} is stale; run npm run build`);
    }
    console.log(`Checked ${profile.outputFile}`);
  } else {
    writeFileSync(outputPath, output);
    console.log(`Wrote ${profile.outputFile}`);
  }
}

if (checkOnly) {
  const ruleFiles = readdirSync(resolve(root, "rules"))
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => `rules/${file}`);
  const moduleFilesToCheck = profiles.flatMap((profile) => profile.moduleFiles);
  for (const file of [...new Set([...moduleFilesToCheck, ...ruleFiles, "tests/cases.yaml"])]) {
    const source = readText(file);
    if (source.includes("\t")) {
      throw new Error(`${file} contains tabs; use spaces for YAML indentation`);
    }
  }
  validateCases(outputs.get("full"));
}
