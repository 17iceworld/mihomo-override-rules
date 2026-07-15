import { resolve4 } from "node:dns/promises";
import { writeFileSync } from "node:fs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const runs = Number(option("runs", "10"));
const output = option("output", "benchmark-result.json");
const label = option("label", "unnamed");
const profile = option("profile", "unknown");
const network = option("network", "unknown");
if (!Number.isInteger(runs) || runs < 10) throw new Error("--runs must be an integer >= 10");

const targets = [
  ["domestic", "https://www.baidu.com/", "www.baidu.com"],
  ["connectivity", "https://www.gstatic.com/generate_204", "www.gstatic.com"],
  ["github", "https://github.com/", "github.com"],
];

const samples = [];
for (let run = 0; run < runs; run += 1) {
  for (const [name, url, domain] of targets) {
    const dnsStart = performance.now();
    await resolve4(domain);
    const dnsMs = performance.now() - dnsStart;
    const requestStart = performance.now();
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    samples.push({ run: run + 1, target: name, dnsMs, requestMs: performance.now() - requestStart, status: response.status });
  }
}

const result = {
  schemaVersion: 1,
  label,
  profile,
  network,
  platform: process.platform,
  arch: process.arch,
  timestamp: new Date().toISOString(),
  runs,
  samples,
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Wrote ${output}; compare only runs captured on the same platform and network`);
