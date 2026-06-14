# Changelog

## 0.3.0

### Summary

This release publishes the first `@fiale-plus/pi-rogue` bundle cut after router trajectory work has been stabilized into the primary public artefact, with safer defaults and user-facing docs for offline sharpening.

### Changes

- Add router functionality to the shipped bundle command surface (`/router`) and keep it in observe-first, opt-in mode.
- Add local sharpening workflow exports and scripts:
  - `router:sharpen` for one-shot hint generation
  - `router:sharpen:auto` for cron/automation refreshes with stable user data paths and manifest-based idempotency
- Add automatic persistence migration and manifest/hash guarding to prevent malformed artifacts from silently persisting.
- Document learning-safety boundaries:
  - route hints are local-only, repo-local by default
  - no raw transcript text is written into learning artifacts
  - no automatic policy mutation (manual promotion remains required)
- Expand docs in `README.md` and `packages/bundle/README.md` to include router usage and release-scope guidance.

### Validation

- `npm run check`
- `npm run test`
- `npm run router:sharpen -- --events <events.jsonl> --output <path>` (on representative data)
- `npm run router:sharpen:auto -- --workspace <repo>` (on representative data)

## 0.2.4

- Release series pre-router docs and baseline route telemetry shipped in prior releases.
