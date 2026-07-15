import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const subscriptionPath = process.argv[2];
if (!subscriptionPath) {
  throw new Error("Usage: npm run audit:subscription -- /path/to/subscription.yaml");
}

const absoluteSubscription = resolve(subscriptionPath);
const before = readFileSync(absoluteSubscription);
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const beforeDigest = digest(before);
const subscription = before.toString("utf8");

const proxySection = subscription.match(/^proxies:\s*\n([\s\S]*?)(?=^[A-Za-z0-9_-]+:|$(?![\s\S]))/mu)?.[1];
const jsonProxyCount = (() => {
  try {
    const parsed = JSON.parse(subscription);
    return Array.isArray(parsed.proxies) ? parsed.proxies.length : 0;
  } catch {
    return 0;
  }
})();
const yamlProxyCount = proxySection?.match(/^\s+-\s+name:/gmu)?.length ?? 0;
const proxyCount = Math.max(jsonProxyCount, yamlProxyCount);
if (proxyCount === 0) throw new Error("Subscription compatibility audit requires at least one proxy");

for (const outputFile of ["mihomo-override.yaml", "mihomo-override_full.yaml"]) {
  const override = readFileSync(resolve(root, outputFile), "utf8");
  if (/^proxies:/mu.test(override)) {
    throw new Error(`${outputFile} replaces subscription proxies`);
  }
  if (!/^allow-lan: false$/mu.test(override)) {
    throw new Error(`${outputFile} does not close LAN access`);
  }
  const autoBlock = override.match(/^  - name: "Auto"\n([\s\S]*?)(?=^  - name:|^rule-providers:)/mu)?.[1] ?? "";
  const proxyBlock = override.match(/^  - name: "PROXY"\n([\s\S]*?)(?=^  - name:|^rule-providers:)/mu)?.[1] ?? "";
  if (!/^    include-all: true$/mu.test(autoBlock) || !/^    include-all: true$/mu.test(proxyBlock)) {
    throw new Error(`${outputFile} cannot discover subscription proxies through include-all`);
  }
}

const afterDigest = digest(readFileSync(absoluteSubscription));
if (afterDigest !== beforeDigest) throw new Error("Subscription changed during read-only audit");
console.log(`Compatibility audit passed: ${basename(absoluteSubscription)} (${proxyCount} proxies, values not displayed)`);
