import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const COMMANDS = [
  { label: 'Initialize config', command: 'repo-arch init', hint: 'write repo-arch.config.json' },
  { label: 'Run prepare flow', command: 'repo-arch flow run --repo .', hint: 'history → cards → dataset → train plan' },
  { label: 'Run full flow', command: 'repo-arch flow run full --repo .', hint: 'includes embeddings and eval' },
  { label: 'Inspect run', command: 'repo-arch flow inspect --repo .', hint: 'show artifacts and next steps' },
  { label: 'Review cards', command: 'repo-arch review list', hint: 'accept/reject before training' },
  { label: 'Train plan', command: 'repo-arch train prepare --repo .', hint: 'prepare LoRA training' },
  { label: 'Train cycle', command: 'repo-arch train cycle --repo .', hint: 'continue the persistent loop' },
  { label: 'Train resume', command: 'repo-arch train resume --repo .', hint: 'resume from latest checkpoint' },
  { label: 'Train status', command: 'repo-arch train status --repo .', hint: 'inspect the current session' },
  { label: 'Train list', command: 'repo-arch train list --repo .', hint: 'show all training sessions' },
  { label: 'Train adapter', command: 'repo-arch train run --repo .', hint: 'execute one-shot LoRA training' },
  { label: 'Explain a file', command: 'repo-arch why src/core.ts --json', hint: 'history for one file' },
  { label: 'Find similar history', command: 'repo-arch similar "why auth middleware token-only?" --json', hint: 'semantic search over cards' },
];

function findConfigFile(cwd: string): string | null {
  const candidates = [
    path.join(cwd, 'repo-arch.config.json'),
    path.join(cwd, '.repo-arch', 'config.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export default function repoArchExtension(pi: ExtensionAPI) {
  pi.registerCommand('repo-arch', {
    description: 'Show the self-contained repo-arch CLI workflow',
    getArgumentCompletions: (prefix) => {
      const options = ['init', 'flow', 'review', 'train', 'eval', 'why', 'similar'];
      const filtered = options.filter((option) => option.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      const configFile = findConfigFile(cwd);
      const withConfig = (cmd: string) => (configFile ? cmd.replace(' --repo .', ` --repo . --config ${path.relative(cwd, configFile)}`) : cmd);
      const choices = COMMANDS.map((entry) => `${entry.label} — ${withConfig(entry.command)} — ${entry.hint}`);

      const selected = await ctx.ui.select('repo-arch workflow', choices);
      if (!selected) return;

      const command = selected.split(' — ')[1] ?? selected;
      ctx.ui.notify(command, 'info');
    },
  });
}
