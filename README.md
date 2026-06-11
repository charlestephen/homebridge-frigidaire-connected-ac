# homebridge-frigidaire-connected-ac

A [Homebridge](https://homebridge.io) plugin that controls **Frigidaire WiFi
(Connected) air conditioners** directly from HomeKit, using your Frigidaire app
account.

It is a modernized rewrite (ESM, Homebridge v2 API, TypeScript) of
[`@reedptaylor/homebridge-frigidaire-ac-plugin`](https://www.npmjs.com/package/@reedptaylor/homebridge-frigidaire-ac-plugin),
with a **native, dependency-free** TypeScript client for the Frigidaire /
Electrolux OCP cloud API — it no longer depends on `@samthegeek/frigidaire` (or
any other runtime package).

## What you get per AC

- **HeaterCooler** — on/off, current & target temperature, cooling state (cooling only).
- **Fan** — on/off, speed (low / medium / high), vertical swing.
- **Eco Mode** switch.
- **Filter** status sensor.

## Install

```sh
npm install -g homebridge-frigidaire-connected-ac
```

No runtime dependencies — the Frigidaire cloud client is built in.

## Configure

Use the Homebridge UI (the config form is provided), or add a platform block:

```json
{
  "platforms": [
    {
      "platform": "FrigidaireACPlatform",
      "username": "you@example.com",
      "password": "your-frigidaire-password",
      "pollingInterval": 10000,
      "cacheRefreshToken": true
    }
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `username` | — | Frigidaire account email (required). |
| `password` | — | Frigidaire account password (required). |
| `countryCode` | `US` | ISO country code for your account region (required by the cloud API). |
| `pollingInterval` | `10000` | How often (ms) to refresh from the cloud. Too low risks rate-limiting. |
| `cacheRefreshToken` | `true` | Cache the auth token to reduce logins. |

## Notes

- Requires **Homebridge ≥ 1.8** (works on Homebridge 2.x) and **Node ≥ 20**.
- This talks to Frigidaire's (unofficial) cloud API, so the ACs must be online
  and set up in the Frigidaire app first.
- HomeKit reads return the last polled value instantly and update in the
  background; writes are sent to the cloud immediately.

## Develop

```sh
npm install
npm run build   # tsc -> dist/
npm run lint
```

### Live test (read-only)

Validate auth + discovery + telemetry against your real account without HomeKit:

```sh
npm run build
FRIGIDAIRE_USER='you@example.com' FRIGIDAIRE_PASS='secret' node test/live-test.mjs
```

It prints each discovered AC and its parsed state, and sends no commands.

## License

Apache-2.0
