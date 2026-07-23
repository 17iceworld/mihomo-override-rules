# Mihomo Override Rules

Modular Mihomo override rules for Sparkle. This repository keeps routing, DNS policy, icons, and public rule-provider wiring separate from private VPS subscription data.

## What This Includes

- Two generated overrides:
  - `mihomo-override.yaml`: light profile for common AI, Google, YouTube, Telegram, GitHub/GitLab, domestic, non-China, private, ad-block, and final routing.
  - `mihomo-override_full.yaml`: expanded profile with Apple CN/Global, Microsoft/OneDrive, TikTok, X/Twitter, Instagram, Reddit, Game, and extra AI routing.
- Clean strategy group names such as `PROXY`, `Auto`, `AI`, `AdBlock`, `Domestic`, and `Final`.
- PNG proxy group icons from `icons/`, referenced through GitHub raw URLs.
- Inline custom domain rules under `rules/` for AI, Apple CN, direct CN, direct global, X, Instagram, and Reddit.
- Remote MetaCubeX MRS rule providers for common services, China geosite/geoip, private IP, ads, and game platforms.
- Process-aware Parsec routing: private and mainland China peer IPs use `DIRECT`, all other Parsec traffic uses `PROXY`, and Parsec STUN remains direct for P2P negotiation.
- DNS policy using `fake-ip`, AliDNS/DNSPod DoH for private, China, Apple CN, and general Microsoft/OneDrive rules, and Cloudflare/Google DoH for AI and other proxied or global rules.
- Explicitly closed LAN access and routed DNS transports (`#DIRECT` for bootstrap and direct-DNS exceptions, and `#PROXY` for AI and other global queries). AI DNS policies precede Microsoft/OneDrive so overlapping services such as Copilot keep using proxy DNS.

## Profile Differences

### Light

`mihomo-override.yaml` is built from:

- `modules/dns.yaml`
- `modules/proxy-groups.yaml`
- `modules/rule-providers.yaml`
- `modules/rules.yaml`

Light groups:

```text
Auto, PROXY, AI, AdBlock, YouTube, Google, Telegram, GitHub, NonChina, Private, Domestic, Final
```

Light routing covers direct/private traffic, custom direct domains, ads, AI, OpenAI, YouTube, Google, Telegram, GitHub/GitLab, China domain/IP, non-China domains, Google IP, Telegram IP, and final fallback.

Google and GitHub default to the `AI` group so Gemini and Copilot authentication use the same selected exit as their AI service traffic. Full applies the same default to Microsoft for shared Copilot login endpoints. Existing profiles with `store-selected` may retain an older manual group selection; select `AI` once in those groups to opt into the shared exit.

### Full

`mihomo-override_full.yaml` is built from:

- `modules/full-dns.yaml`
- `modules/full-proxy-groups.yaml`
- `modules/full-rule-providers.yaml`
- `modules/full-rules.yaml`

Full includes every light group plus:

```text
Apple CN, Apple, Microsoft, TikTok, X, Instagram, Reddit, Game
```

Full also adds rule providers for `anthropic`, `apple-cn`, `apple`, `microsoft`, `onedrive`, `tiktok`, `twitter`, `instagram`, `reddit`, `category-games`, `steam`, `epicgames`, `xbox`, `playstation`, and `nintendo`.

## Repository Layout

```text
.
├── README.md
├── mihomo-override.yaml
├── mihomo-override_full.yaml
├── icons/
│   ├── adblock.png
│   ├── ai.png
│   ├── apple-cn.png
│   ├── apple.png
│   ├── auto.png
│   ├── domestic.png
│   ├── final.png
│   ├── game.png
│   ├── github.png
│   ├── google.png
│   ├── instagram.png
│   ├── microsoft.png
│   ├── nonchina.png
│   ├── private.png
│   ├── proxy.png
│   ├── reddit.png
│   ├── telegram.png
│   ├── tiktok.png
│   ├── x.png
│   └── youtube.png
├── modules/
│   ├── dns.yaml
│   ├── full-dns.yaml
│   ├── full-proxy-groups.yaml
│   ├── full-rule-providers.yaml
│   ├── full-rules.yaml
│   ├── proxy-groups.yaml
│   ├── rule-providers.yaml
│   └── rules.yaml
├── rules/
│   ├── ai.yaml
│   ├── apple-cn.yaml
│   ├── direct-cn.yaml
│   ├── direct-global.yaml
│   ├── instagram.yaml
│   ├── reddit.yaml
│   └── x.yaml
├── scripts/
│   └── build-override.js
├── tests/
│   └── cases.yaml
└── package.json
```

## Build And Test

```bash
npm run build
npm test
```

`npm run build` merges the configured module files in `scripts/build-override.js`, expands each `payload-from` rule file, applies the selected rule mirror, then writes both generated override files. The default mirror remains `gh-proxy` for restricted networks; choose another source when building if needed:

```bash
RULE_MIRROR=direct npm run build
RULE_MIRROR=jsdelivr npm run build
```

Supported values are `direct`, `gh-proxy`, and `jsdelivr`. Use the same value with `npm test` when checking a non-default generated profile.

`npm test` runs the build in check mode. It validates:

- no tab indentation in modules, rule files, or test cases
- no duplicate top-level YAML keys within each generated profile
- all `RULE-SET`, `GEOIP`, and `MATCH` outbounds reference existing groups
- all referenced rule providers exist
- HTTP rule providers include required fields
- generated rule-provider URLs do not use unproxied raw GitHub URLs
- DNS `rule-set:` policies reference existing providers
- Microsoft/OneDrive DNS exceptions use `#DIRECT`, while higher-priority overlapping AI policies use `#PROXY`
- generated overrides are current and check mode never rewrites them
- proxy groups have no unknown references or dependency cycles
- rules contain no duplicates, end in exactly one `MATCH`, and IP rules use `no-resolve`
- Parsec process rules enter an ordered private/CN-IP/direct-else-proxy sub-rule, while only its STUN endpoints receive unconditional direct exceptions
- encrypted DNS bootstrap, closed LAN access, and explicit direct-exception/proxy DNS routes
- cases in `tests/cases.yaml` reference valid rules in the full profile
- inline-domain cases resolve to the expected first matching inline provider and outbound

Run the networked Mihomo integration suite separately:

```bash
npm run test:runtime
```

It discovers Mihomo from `MIHOMO_BIN`, the Clash Party sidecar, or `PATH`, then verifies that every remote MRS in the full profile downloads through the configured mirror and decodes with Mihomo. After decoding, every case in `tests/cases.yaml` must match its expected first inline or remote provider. The suite also starts isolated Mihomo instances to check `/rules` API order, runtime match logs, intentionally overlapping providers, IPv6-only loopback traffic, cached-provider offline restart, and a no-cache download failure that must not reach a DIRECT target. The suite needs network access and an installed Mihomo binary.

It also runs a compatibility audit against a credential-free three-node fixture. To audit a real subscription without modifying or printing its nodes:

```bash
npm run audit:subscription -- /absolute/path/to/subscription.yaml
```

For cross-platform TUN and performance verification, follow `tests/CROSS_PLATFORM_TESTS.zh-CN.md`. The benchmark commands require at least ten samples:

```bash
npm run benchmark -- --label baseline --profile light --network home --runs 10 --output baseline.json
npm run benchmark -- --label candidate --profile light --network home --runs 10 --output candidate.json
npm run benchmark:compare -- baseline.json candidate.json
```

Only compare adjacent runs from the same platform and network. The comparator rejects median DNS or request regressions above 10%.

Generated files start with:

```yaml
# Generated by scripts/build-override.js.
# Edit files under modules/ and rules/ instead.
```

Edit `modules/` and `rules/`, then rebuild.

## Sparkle Usage

1. Add your VPS subscription in Sparkle.
2. Add one override as a remote override.

Light:

```text
https://raw.githubusercontent.com/<your-user>/<your-repo>/main/mihomo-override.yaml
```

Full:

```text
https://raw.githubusercontent.com/<your-user>/<your-repo>/main/mihomo-override_full.yaml
```

3. Apply the profile and check that Mihomo starts without provider or strategy group errors.

## Verification Cases

The checked cases live in `tests/cases.yaml` and target the full profile:

- `chatgpt.com`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, and `cursor.com` -> `AI`
- `apple.com.cn` -> `Apple CN`
- `icloud.com` -> `Apple`
- `microsoft.com` -> `Microsoft`
- `tiktok.com` -> `TikTok`
- `x.com` -> `X`
- `instagram.com` -> `Instagram`
- `reddit.com` -> `Reddit`
- `store.steampowered.com` -> `Game`
- `baidu.com` -> `Domestic`
- `dogni.work` -> `DIRECT`
- `stun.parsec.app` and `stun6.parsec.app` -> `DIRECT`
- `example.cn` -> `DIRECT`

Additional manual checks:

- `youtube.com` -> `YouTube`
- `google.com` -> `Google`
- `telegram.org` -> `Telegram`
- `github.com` and `gitlab.com` -> `GitHub`
- geolocation non-China domains -> `NonChina`
- domains from MetaCubeX `category-ads-all` -> `AdBlock`
- AI and other global DNS leak tests should not show the local ISP DNS; private, China, Apple CN, and general Microsoft/OneDrive domains may resolve through AliDNS or DNSPod DoH

## Rule Order

Routing is intentionally ordered from specific to broad:

1. private and explicit custom exceptions
2. Parsec process routing by private/China/other destination IP
3. ad blocking
4. service-specific rules
5. broad China domain/IP rules
6. non-China domain rules
7. Google and Telegram IP rules
8. final fallback

Put allow/direct exceptions before broad remote rule providers if a site is overmatched.

## Ad Blocking

Ad blocking uses the remote MetaCubeX `category-ads-all` MRS provider:

```yaml
RULE-SET,category-ads-all,AdBlock
```

If a site or app breaks because of overblocking, switch the `AdBlock` group to `DIRECT` temporarily or add a narrower allow/direct rule before the ad rule.

## Security Rules

Never commit:

- VPS subscription URLs
- proxy server addresses intended to stay private
- UUIDs, passwords, private keys, tokens, or cookies
- home IPs, personal domains that should stay private, or internal network details
