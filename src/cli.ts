#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { bootstrap } from './store/bootstrap.js';

const USAGE = `bearclaw <command> [options]

Commands:
  migrate-fs [--dry-run] [--force] [--no-keep-files]
      Import ~/.bearclaw's files (.env, context, agents, skills, workflows,
      config) into the config database. Files stay where they are unless
      --no-keep-files moves them aside to legacy-YYYYMMDD/.

  config list [--secret]        List settings (secrets redacted unless --secret)
  config get <key>              Print one setting
  config set <key> <value> [--secret]
                                Write a setting (keys matching
                                TOKEN/KEY/PASSWORD/SECRET are stored secret)
  config unset <key>            Remove a setting

  whatsapp-auth                 Pair WhatsApp by QR code

Environment:
  BEARCLAW_HOME                 Install root (default ~/.bearclaw)
`;

function fail(message: string): number {
  console.error(message);
  return 1;
}

async function cmdMigrateFs(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'keep-files': { type: 'boolean', default: true },
      'no-keep-files': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  bootstrap();
  const { importLegacyFs } = await import('./store/import-legacy.js');
  const report = importLegacyFs({
    dryRun: values['dry-run'],
    force: values.force,
    keepFiles: values['keep-files'] && !values['no-keep-files'],
  });

  const lines: string[] = [];
  lines.push(report.dryRun ? 'migrate-fs (dry run)' : 'migrate-fs');
  lines.push(`  home            ${report.home}`);
  lines.push(`  detected        ${report.detected.join(', ') || '(nothing)'}`);
  lines.push(`  settings        ${report.settings.length}`);
  lines.push(
    `  password        ${report.passwordSet ? 'imported' : 'unchanged'}`,
  );
  lines.push(`  agents          ${report.agents.length}`);
  lines.push(`  context files   ${report.contextFiles.length}`);
  lines.push(
    `  skills          ${report.skills.length} (${report.skills.reduce((n, s) => n + s.files, 0)} files)`,
  );
  lines.push(`  skill sources   ${report.skillSources.length}`);
  lines.push(`  mcp servers     ${report.mcpServers.length}`);
  lines.push(
    `  model catalog   ${report.modelCatalog ? 'imported' : 'default'}`,
  );
  lines.push(`  workflows       ${report.workflows.length}`);
  lines.push(`  onboarded       ${report.onboarded ? 'yes' : 'no'}`);
  if (report.movedRuntimeFiles.length) {
    lines.push(
      `  runtime files   ${report.keepFiles ? 'would move' : 'moved'} ${report.movedRuntimeFiles.length}`,
    );
    for (const m of report.movedRuntimeFiles)
      lines.push(`    ${m.from} -> ${m.to}`);
  }
  if (report.legacyDir) lines.push(`  legacy dir      ${report.legacyDir}`);
  if (report.keepFiles && !report.dryRun) {
    lines.push('  note            --keep-files is on: nothing was moved aside');
  }
  for (const err of report.errors) {
    lines.push(`  error ${err.source}: ${err.issues.join('; ')}`);
  }
  console.log(lines.join('\n'));
  return 0;
}

async function cmdConfig(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { secret: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const [action, key, value] = positionals;
  bootstrap();
  const settings = await import('./store/settings.js');

  switch (action) {
    case undefined:
    case 'list': {
      const rows = settings.listSettings({ redact: !values.secret });
      if (rows.length === 0) {
        console.log('(no settings)');
        return 0;
      }
      const width = Math.max(...rows.map((r) => r.key.length));
      for (const row of rows) {
        console.log(`${row.key.padEnd(width)}  ${row.value}`);
      }
      return 0;
    }
    case 'get': {
      if (!key) return fail('config get <key>');
      const found = settings.getSetting(key);
      if (found === undefined) return fail(`${key} is not set`);
      console.log(found);
      return 0;
    }
    case 'set': {
      if (!key || value === undefined) return fail('config set <key> <value>');
      settings.setSetting(key, value, values.secret ? { secret: true } : {});
      console.log(`${key} set (restart BearClaw to pick it up)`);
      return 0;
    }
    case 'unset': {
      if (!key) return fail('config unset <key>');
      if (!settings.deleteSetting(key)) return fail(`${key} is not set`);
      console.log(`${key} removed (restart BearClaw to pick it up)`);
      return 0;
    }
    default:
      return fail(`Unknown config action: ${action}`);
  }
}

async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  switch (command) {
    case 'migrate-fs':
      return cmdMigrateFs(rest);
    case 'config':
      return cmdConfig(rest);
    case 'whatsapp-auth': {
      bootstrap();
      const { runWhatsappAuth } = await import('./cli/whatsapp-auth.js');
      await runWhatsappAuth();
      return 0;
    }
    default:
      console.error(USAGE);
      return fail(`Unknown command: ${command}`);
  }
}

run(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
