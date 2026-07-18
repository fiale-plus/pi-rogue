# Harmonization evidence pack

The repository includes a checked-in, offline evidence pack for the harmonization gates identified after issues #379 and #381.

```bash
npm --silent run harmonization:evidence
npm --silent run harmonization:evidence -- --output docs/benchmark-evidence/harmonization-evidence-pack.v1.json
npm --silent run harmonization:evidence -- --format csv --output /tmp/harmonization-evidence.csv
npm --silent run harmonization:evidence -- --input path/to/pack.json
```

The JSON output is versioned as `pi-rogue.harmonization-evidence.v1`. It contains 24 stratified synthetic fixtures across Router, Advisor, Orchestration, and Context Broker. Each record contains only fixture IDs, categorical labels, bounded cost bands, bounded rework counts, and boolean usage flags. The aggregate section counts accepted outcomes, escalation labels/reasons, rework, fallback classes, usage, and Context Broker availability/savings bands.

## Interpretation

This is directional evidence for schema and decision-process testing, not a production performance measurement. The fixtures do not establish actual spend, token savings, escalation precision/recall, or command usage. They make the required evidence dimensions explicit and provide a reproducible baseline for replacing synthetic cases with separately reviewed representative evidence later.

The validator fails closed on unknown fields and rejects names associated with prompts, transcripts, payloads, filesystem paths, secrets, credentials, user identifiers, raw data, or content. No network calls, production credentials, runtime instrumentation, telemetry upload, routing changes, model selection, worker dispatch, or policy mutation are involved.

The CSV format is a tabular projection of records. The JSON format should be used when aggregate counts and the schema envelope are required.

## Evidence still required before simplification

Before removing aliases, reducing policy knobs, quarantining board/specialist machinery, or consolidating feature vocabularies, collect representative local evidence for:

- spend and token/call cost per independently accepted task;
- escalation precision and recall;
- rework after review, model switching, or worker dispatch;
- fallback and failure rates;
- command and configuration usage; and
- Context Broker prompt-token savings and evidence retention.

Any replacement evidence must document sampling method, missing fields, privacy review, and confidence limits. It must not be silently regenerated from live sessions.
