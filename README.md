# Mihomo Override Rules

Modular Mihomo override rules for Sparkle. This repository keeps routing and DNS policy separate from private VPS subscription data.

## What This Includes

- AI routing for OpenAI, ChatGPT, Claude, Gemini, Perplexity, Poe, and Copilot.
- Ad blocking with MetaCubeX `category-ads-all` MRS rules.
- Domestic domain and IP routing with MetaCubeX China geosite/geoip rule sets.
- DNS leak reduction with `fake-ip`, domestic DoH for China rules, and Cloudflare DoH for proxied domains.
- A generated `mihomo-override.yaml` for direct import or remote override use.

## Repository Layout

```text
.
├── mihomo-override.yaml
├── modules/
│   ├── dns.yaml
│   ├── proxy-groups.yaml
│   ├── rule-providers.yaml
│   └── rules.yaml
├── rules/
│   ├── ai.yaml
│   └── direct.yaml
└── scripts/
    └── build-override.js
```

## Build

```bash
npm install
npm run build
npm test
```

`npm run build` merges files from `modules/` in a fixed order and writes `mihomo-override.yaml`.

## Sparkle Usage

1. Add your VPS subscription in Sparkle.
2. Add this override file as a remote override:

```text
https://raw.githubusercontent.com/<your-user>/<your-repo>/main/mihomo-override.yaml
```

3. Apply the profile and check that Mihomo starts without provider or strategy group errors.

## Verification

- AI: `chatgpt.com`, `claude.ai`, and `gemini.google.com` should match `AI`.
- Domestic direct: common China sites such as `baidu.com`, `qq.com`, and `taobao.com`, plus `dogni.work`, should match `DIRECT`.
- Ads: domains from MetaCubeX `category-ads-all` should match `AdBlock`.
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
RULE-SET,category-ads-all,AdBlock
```

If a site or app breaks because of overblocking, switch the `AdBlock` group to `DIRECT` temporarily or add a narrower allow/direct rule before the ad rule.
