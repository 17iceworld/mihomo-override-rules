import { readFileSync } from "node:fs";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  throw new Error("Usage: npm run benchmark:compare -- baseline.json candidate.json");
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
if (baseline.platform !== candidate.platform || baseline.network !== candidate.network) {
  throw new Error("Benchmarks must use the same platform and network label");
}

const percentile = (values, ratio) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};
const summarize = (result, target, metric) => {
  const values = result.samples.filter((sample) => sample.target === target).map((sample) => sample[metric]);
  return { median: percentile(values, 0.5), p95: percentile(values, 0.95) };
};

let failed = false;
for (const target of ["domestic", "connectivity", "github"]) {
  for (const metric of ["dnsMs", "requestMs"]) {
    const base = summarize(baseline, target, metric);
    const next = summarize(candidate, target, metric);
    const regression = ((next.median - base.median) / base.median) * 100;
    console.log(`${target} ${metric}: median ${next.median.toFixed(1)}ms, p95 ${next.p95.toFixed(1)}ms, regression ${regression.toFixed(1)}%`);
    if (regression > 10) failed = true;
  }
}
if (failed) throw new Error("Candidate exceeds the 10% median regression budget");
