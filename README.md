# Mihomo Override Rules

Modular Mihomo override rules for Sparkle. This repository keeps routing and DNS policy separate from private VPS subscription data.

## What This Includes

- AI routing for OpenAI, ChatGPT, Claude, Gemini, Perplexity, Poe, and Copilot.
- Service routing for YouTube, Google, Telegram, GitHub, GitLab, domestic, non-China, and private traffic.
- ASCII tag-labeled strategy groups such as `[PROXY] PROXY`, `[AUTO] Auto`, and `[AI] AI`.
- Ad blocking with MetaCubeX `category-ads-all` MRS rules.
- Domestic domain and IP routing with MetaCubeX China geosite/geoip rule sets.
- DNS leak reduction with `fake-ip`, domestic DoH for China rules, and Cloudflare DoH for proxied domains.
- Flat PNG proxy group icons served from the repository through GitHub raw URLs.
- Generated light and full overrides for direct import or remote override use.

## Repository Layout

```text
.
├── mihomo-override.yaml
├── icons/
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
│   ├── direct.yaml
│   ├── instagram.yaml
│   ├── reddit.yaml
│   └── x.yaml
├── tests/
│   └── cases.yaml
└── scripts/
    └── build-override.js
```

## Build

```bash
npm install
npm run build
npm test
```

`npm run build` merges files from `modules/` in a fixed order and writes:

- `mihomo-override.yaml`: light override.
- `mihomo-override_full.yaml`: full override with Apple CN/Global, Microsoft, TikTok, X, Instagram, Reddit, Game, and expanded AI routing.

Remote rule-provider URLs are generated through `https://gh-proxy.org/https://raw.githubusercontent.com/...`.

## Sparkle Usage

1. Add your VPS subscription in Sparkle.
2. Add this override file as a remote override:

```text
https://raw.githubusercontent.com/<your-user>/<your-repo>/main/mihomo-override.yaml
```

Use the full version if you want the expanded service groups:

```text
https://raw.githubusercontent.com/<your-user>/<your-repo>/main/mihomo-override_full.yaml
```

3. Apply the profile and check that Mihomo starts without provider or strategy group errors.

## Verification

- AI: `chatgpt.com`, `claude.ai`, and `gemini.google.com` should match `[AI] AI`.
- YouTube: `youtube.com` should match `[YT] YouTube`.
- Google: `google.com` should match `[G] Google`.
- Telegram: `telegram.org` should match `[TG] Telegram`.
- GitHub and GitLab: `github.com` and `gitlab.com` should match `[GH] GitHub`.
- Apple China: `apple.com.cn` should match `[APPLE-CN] Apple CN` in the full override.
- Apple global: `icloud.com` should match `[APPLE] Apple` in the full override.
- Microsoft: `microsoft.com` should match `[MS] Microsoft` in the full override.
- TikTok, X, Instagram, and Reddit should match their dedicated full override groups.
- Game: `store.steampowered.com` should match `[GAME] Game` in the full override.
- Domestic direct: common China sites such as `baidu.com`, `qq.com`, and `taobao.com` should match `[CN] Domestic`; `dogni.work` should match `DIRECT`.
- Non-China: geolocation non-China domains should match `[GLOBAL] NonChina`.
- Ads: domains from MetaCubeX `category-ads-all` should match `[AD] AdBlock`.
- DNS: foreign DNS leak tests should not show your local ISP DNS. Domestic domains may resolve through AliDNS or DNSPod DoH.

## Security Rules

Never commit:

- VPS subscription URLs
- Proxy server addresses intended to stay private
- UUIDs, passwords, private keys, tokens, or cookies
- Home IPs, personal domains, or internal network details

## Ad Blocking

Ad blocking uses the remote MetaCubeX `category-ads-all` MRS provider:

```yaml
RULE-SET,category-ads-all,[AD] AdBlock
```

If a site or app breaks because of overblocking, switch the `[AD] AdBlock` group to `DIRECT` temporarily or add a narrower allow/direct rule before the ad rule.
