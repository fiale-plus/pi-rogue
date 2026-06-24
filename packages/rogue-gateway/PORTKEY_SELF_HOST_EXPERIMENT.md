# Portkey self-host experiment for Rogue Gateway spike

This repository cannot launch a live Portkey instance by itself. The experiment is therefore prepared as a **repo-local, env-driven manual run** against an already-running Portkey/OpenAI-compatible endpoint.

## Outcome statement

This spike is a **validated spike / pilot setup**, not target architecture yet.

## What this experiment measures

- `raw_forward`
- `typed_lens`
- `lookup_compress`

For each mode, Rogue resolves `pi-dedicated` through the Pi Rogue router config to the configured upstream GPT target, then measures the routed request against the live endpoint.

## Required runtime configuration

Set these in your shell or runtime environment:

```sh
export PORTKEY_BASE_URL="http://127.0.0.1:8787/v1"
export PORTKEY_API_KEY=""                  # optional for self-host; set if your deployment requires auth
export PORTKEY_AUTH_HEADER="x-portkey-api-key" # optional
export PORTKEY_AUTH_SCHEME="Bearer"        # optional
export PI_ROGUE_CONFIG_PATH="$HOME/.pi/agent/pi-rogue/config.json"
export PI_ROGUE_ROUTER_CONFIG_PATH="$HOME/.pi/agent/pi-rogue/router/config.json"
```

Optional knobs:

```sh
export PI_ROGUE_PROFILE="local-smart"
export PI_ROGUE_ROLE="smart"
export RAW_INPUT_TOKENS="82000"
export FORWARDED_INPUT_TOKENS="2400"
export EXPECTED_OUTPUT_TOKENS="900"
```

## Run command

From repo root:

```sh
cp packages/rogue-gateway/.env.example packages/rogue-gateway/.env
# optionally edit packages/rogue-gateway/.env to match your local paths / auth

docker compose --env-file packages/rogue-gateway/.env -f packages/rogue-gateway/docker-compose.yml up -d
npm run measure:portkey --workspace @fiale-plus/pi-rogue-gateway
```

## Expected output

A JSON report containing:

- resolved profile/role
- `pi-dedicated` requested model
- upstream model target from Pi config
- per-mode route decision
- upstream usage/tokens returned by the live endpoint

## What is still missing for live execution

- A real Portkey/OpenAI-compatible base URL
- A running Portkey self-host instance (or other compatible endpoint)
- Optional auth only if your deployment requires it
