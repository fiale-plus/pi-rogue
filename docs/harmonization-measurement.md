# Harmonization measurement harness

The repository includes a fixture-driven, offline measurement harness for the next harmonization phase:

```bash
npm --silent run harmonization:measure
npm --silent run harmonization:measure -- --output /tmp/harmonization-observations.json
npm --silent run harmonization:measure -- --disabled
```

Use `npm --silent` when stdout is being captured as machine-readable JSON; ordinary `npm run` includes npm's lifecycle header.

The output is versioned as `pi-rogue.harmonization-observation.v1`. It records allowlisted observations from current public entry points without changing runtime behavior:

- Router status and route decisions;
- Orchestration status;
- Advisor worker-result review;
- Context Broker source handling; and
- the harness dispatcher’s unknown-feature handling.

Fixtures cover explicit and default routes, unknown features, absent/empty optional input, malformed-safe status defaults, and conflicting correlation metadata. Correlation identifiers are hashed. Raw prompts, transcripts, payloads, filesystem paths, secrets, and user content are excluded from the report.

The harness runs against temporary state only. It is not registered with Pi, does not wrap runtime dispatch, and cannot influence routing, defaults, model selection, worker authority, or policy. `--disabled` produces an empty observation set and exists to make this non-control boundary explicit.

## Evidence gates

This harness is a baseline, not a production telemetry pipeline. Before consolidating vocabularies, removing aliases, reducing policy knobs, or quarantining feature machinery, collect representative evidence for:

- spend per independently accepted task;
- token and call cost by model and feature;
- escalation precision/recall;
- rework after review, model switching, or worker dispatch;
- fallback and failure rates;
- command/configuration usage; and
- Context Broker prompt-token savings and evidence retention.

Baseline changes must be reviewed as fixture changes; they must not be silently regenerated from live sessions.
