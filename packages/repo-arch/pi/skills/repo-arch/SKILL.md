---
name: repo-arch
description: Project archaeology CLI for turning git history into cards, embeddings, datasets, and training runs. Use when you want the CLI flow or guided repo-memory setup.
---

# Repo-Arch

A CLI-first project-memory engine. Install it: `npm install -g @fiale-plus/repo-arch`

## Quick start

```bash
repo-arch init
repo-arch flow run --repo .
repo-arch flow run full --repo .
repo-arch flow inspect --repo .
```

## Core workflow

1. `repo-arch init` — write a starter `repo-arch.config.json`
2. `repo-arch flow run` — build history, cards, dataset, and train plan
3. `repo-arch flow run full` — also build embeddings and evaluation
4. `repo-arch flow inspect` — see run status, artifacts, and next steps
5. `repo-arch review list` — curate accepted/rejected cards
6. `repo-arch eval` — compare retrieval strategies
7. `repo-arch dataset` — export training examples from accepted cards
8. `repo-arch train prepare` — export training plan
9. `repo-arch train cycle` — continue the persistent training loop
10. `repo-arch train resume` — resume from the latest checkpoint
11. `repo-arch train run` — execute training directly

## Investigation commands

```bash
repo-arch why src/core.ts --json
repo-arch check-diff --base main --json
repo-arch check-stale --json
repo-arch similar "why auth middleware token-only?" --json
```

## Integration

This package (`@fiale-plus/pi-repo-arch`) is the Pi integration bridge. The standalone CLI lives at `@fiale-plus/repo-arch`.
