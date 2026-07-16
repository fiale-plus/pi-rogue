# Pi-Rogue configuration UX

Pi-Rogue has one public package and one explicit configuration surface. Users should begin at `/pi-rogue`, then use a subsystem command when they intend to inspect or change that subsystem.

## Design principles

- Keep the hosted Pi model as the controller.
- Make routing, advisor review, context retention, and orchestration visible.
- Prefer a few understandable posture presets over a matrix of independent switches.
- Keep status and doctor commands read-only; writes require an explicit subsystem command or posture command.
- Never imply that a worker can plan, review, select models, or change configuration.

## Supported command roots

| Surface | Purpose |
|---|---|
| `/pi-rogue` | Aggregate status, doctor checks, and posture help. |
| `/pi-rogue-advisor` | Advisor mode, review policy, model, and gate status. |
| `/pi-rogue-router` | Router telemetry, profiles, and explicit routing mode. |
| `/pi-rogue-context` | Durable artifact lookup and context footprint management. |
| `/pi-rogue-orchestration` | Explicit goals, loops, and autoresearch. |
| `/cfg posture guarded` | Apply the compact guarded posture preset. |

Advisor control leaves are `status`, `settings`, `config`, `on`, `off`, `mode`, `review`, `model`, `gate`, `profile`, `checkins`, `pause`, `unpause`, and `board`.

No implicit background command aliases are required. Status commands must not modify files.

## Configuration locations

The user-root configuration lives below `~/.pi/agent/pi-rogue/`:

```text
config.json                         # aggregate summary
router/config.json                  # router mode and profiles
router/model-cards.jsonl            # model capability cards
context-broker/config.json          # broker thresholds and lenses
context-broker/artifacts.sqlite     # durable artifact store
```

The advisor keeps its own user configuration at `~/.pi/agent/pi-rogue/advisor/config.json`. The layering order is built-in defaults, user-root configuration, then session state.

## Posture behavior

The supported compact posture is `guarded`. It keeps the advisor in a bounded auto/light configuration, uses a shadow board with cheap suggested specialists, disables router execution, and keeps durable context enabled. Applying it is explicit:

```text
/cfg posture guarded
```

The command writes only the documented user-root configuration files and reports the resulting paths. `/pi-rogue status` and `/pi-rogue doctor` remain read-only.

## Routing behavior

Router profiles are ordinary model mappings. The supported defaults are `balanced` and `quick`, with optional `spark-smart`, `local-smart`, and `all-smart` profiles when configured. Router mode defaults to `observe`; `auto_model` is an explicit opt-in and only changes future model selection. It does not spawn agents, mutate tools, or change advisor configuration.

## Context behavior

The context broker stores bounded summaries and exact payloads behind `ctx://` handles. Use `/pi-rogue-context brief` for a compact view and `context_lookup` when exact evidence is needed. Large payloads should not be pasted into prompts merely to make them available.

## Acceptance checklist

A configuration UX change is complete when:

- `/pi-rogue help` names only supported command roots;
- status and doctor paths are read-only;
- generated files contain no removed subsystem keys;
- package smoke tests validate the single public artifact; and
- docs describe the same commands and files as the implementation.
