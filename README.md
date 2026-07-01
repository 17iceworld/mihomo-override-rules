# Mihomo Override Rules

Modular Mihomo override rules for Sparkle. This repository keeps routing and DNS policy separate from private VPS subscription data.

## What This Includes

- AI routing for OpenAI, ChatGPT, Claude, Gemini, Perplexity, Poe, and Copilot.
- Lightweight ad blocking with ACL4SSR `BanAD.list`.
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
│   ├── ads.yaml
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
- Domestic direct: common China sites should match `DIRECT`.
- Ads: domains from ACL4SSR `BanAD.list` should match `AdBlock`.
- DNS: foreign DNS leak tests should not show your local ISP DNS. Domestic domains may resolve through AliDNS or DNSPod DoH.

## Security Rules

Never commit:

- VPS subscription URLs
- Proxy server addresses intended to stay private
- UUIDs, passwords, private keys, tokens, or cookies
- Home IPs, personal domains, or internal network details

## Optional Stronger Ad Blocking

The default ad provider is intentionally conservative:

```text
https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanAD.list
```

If you need stronger blocking, consider adding a separate optional provider such as blackmatrix7 `Advertising.yaml`, then route it to `AdBlock`. Do not enable large rulesets by default until you have tested app compatibility.
