#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { bootstrap } from './store/bootstrap.js';

const USAGE = `bearclaw <command> [options]

Commands:
  setup [--yes] [--generate] [--skip-build] [--skip-web] [--skip-services]
      Install or repair this machine: fill the config database, seed the
      starter context, render the launchd agents, build, and start the
      services. Safe to rerun. --generate prints a random web password
      instead of asking for one.

  doctor [--json] [--skip-services]
      Check the install and print one line per check. Exits 1 on a failure.

  export [file] [--with-conversations] [--with-messages]
      Write a bundle holding the config database, the channel credentials
      and a manifest. The bundle contains secrets in the clear.

  import <bundle> [--force] [--skip-setup] [--skip-build] [--skip-web]
                  [--skip-services]
      Restore a bundle into BEARCLAW_HOME, then run setup for the parts
      that belong to this machine. --force moves an existing database aside.

  migrate-fs [--dry-run] [--force] [--keep-files]
      Import ~/.bearclaw's files (.env, context, agents, skills, workflows,
      config) into the config database, then move the originals aside to
      legacy-YYYYMMDD/. --keep-files leaves them where they are.

  config list [--secret]        List settings (secrets redacted unless --secret)
  config get <key>              Print one setting
  config set <key> <value> [--secret]
                                Write a setting (keys matching
                                TOKEN/KEY/PASSWORD/SECRET are stored secret)
  config unset <key>            Remove a setting
  config mcp list               List MCP servers
  config mcp set <name> <json>  Write one MCP server definition
  config mcp rm <name>          Remove an MCP server
  config mcp enable|disable <name>
                                Toggle an MCP server
  config catalog show           Print the model catalog
  config catalog import <file>  Replace the model catalog from a JSON file

  workflows list                List workflow definitions
  workflows export <slug> [file]
                                Write one definition to a file, or stdout
  workflows import <file> [--replace]
                                Add a definition from a file

  whatsapp-auth                 Pair WhatsApp by QR code

Environment:
  BEARCLAW_HOME                 Install root (default ~/.bearclaw)
  BEARCLAW_LAUNCH_AGENTS_DIR    Where setup writes plists
                                (default ~/Library/LaunchAgents)
`;

function fail(message: string): number {
  console.error(message);
  return 1;
}

async function cmdSetup(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: 'boolean', default: false },
      generate: { type: 'boolean', default: false },
      'skip-web': { type: 'boolean', default: false },
      'skip-services': { type: 'boolean', default: false },
      'skip-build': { type: 'boolean', default: false },
      'launch-agents-dir': { type: 'string' },
    },
    allowPositionals: false,
  });
  const { runSetup } = await import('./cli/setup.js');
  return runSetup({
    yes: values.yes,
    generate: values.generate,
    skipWeb: values['skip-web'],
    skipServices: values['skip-services'],
    skipBuild: values['skip-build'],
    launchAgentsDir: values['launch-agents-dir'],
  });
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      'skip-services': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const { runDoctor } = await import('./cli/doctor.js');
  return runDoctor({
    json: values.json,
    skipServices: values['skip-services'],
  });
}

async function cmdExport(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'with-conversations': { type: 'boolean', default: false },
      'with-messages': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  // No bootstrap(): export snapshots the database on disk, it never creates one.
  const { runExport } = await import('./cli/export.js');
  return runExport({
    out: positionals[0],
    withConversations: values['with-conversations'],
    withMessages: values['with-messages'],
  });
}

async function cmdImport(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      force: { type: 'boolean', default: false },
      'skip-setup': { type: 'boolean', default: false },
      'skip-web': { type: 'boolean', default: false },
      'skip-services': { type: 'boolean', default: false },
      'skip-build': { type: 'boolean', default: false },
      'launch-agents-dir': { type: 'string' },
    },
    allowPositionals: true,
  });
  if (!positionals[0]) return fail('import <bundle.tgz>');
  // Deliberately no bootstrap(): the database arrives with the bundle.
  const { runImport } = await import('./cli/import.js');
  return runImport(positionals[0], {
    force: values.force,
    skipSetup: values['skip-setup'],
    skipWeb: values['skip-web'],
    skipServices: values['skip-services'],
    skipBuild: values['skip-build'],
    launchAgentsDir: values['launch-agents-dir'],
  });
}

async function cmdMigrateFs(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'keep-files': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  bootstrap();
  const { importLegacyFs } = await import('./store/import-legacy.js');
  const report = importLegacyFs({
    dryRun: values['dry-run'],
    force: values.force,
    keepFiles: values['keep-files'],
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
  if (!report.dryRun && !report.keepFiles) {
    lines.push('');
    if (report.detected.includes('.git')) {
      lines.push(`${report.home} is no longer a git repository.`);
      lines.push(`Its history is kept at ${report.legacyDir}/.git.`);
    }
    lines.push('`bearclaw export` is the backup path from here on.');
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
  if (action === 'mcp') return cmdConfigMcp(positionals.slice(1));
  if (action === 'catalog') return cmdConfigCatalog(positionals.slice(1));
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

async function cmdConfigMcp(argv: string[]): Promise<number> {
  const [action, name, body] = argv;
  const mcp = await import('./store/mcp.js');

  switch (action) {
    case undefined:
    case 'list': {
      const rows = mcp.listMcpServers();
      if (rows.length === 0) {
        console.log('(no mcp servers)');
        return 0;
      }
      for (const row of rows) {
        console.log(
          `${row.name}${row.enabled ? '' : ' (disabled)'}  ${JSON.stringify(row.config)}`,
        );
      }
      return 0;
    }
    case 'set': {
      if (!name || !body) return fail('config mcp set <name> <json>');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        return fail(
          `invalid JSON: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return fail('the server definition must be a JSON object');
      mcp.putMcpServer(name, parsed as Record<string, unknown>);
      console.log(`${name} set (restart BearClaw to pick it up)`);
      return 0;
    }
    case 'rm': {
      if (!name) return fail('config mcp rm <name>');
      if (!mcp.deleteMcpServer(name)) return fail(`${name} is not configured`);
      console.log(`${name} removed (restart BearClaw to pick it up)`);
      return 0;
    }
    case 'enable':
    case 'disable': {
      if (!name) return fail(`config mcp ${action} <name>`);
      if (!mcp.setMcpServerEnabled(name, action === 'enable'))
        return fail(`${name} is not configured`);
      console.log(`${name} ${action}d (restart BearClaw to pick it up)`);
      return 0;
    }
    default:
      return fail(`Unknown config mcp action: ${action}`);
  }
}

async function cmdConfigCatalog(argv: string[]): Promise<number> {
  const [action, file] = argv;
  const models = await import('./store/models.js');

  switch (action) {
    case undefined:
    case 'show': {
      const catalog = models.getModelCatalog();
      console.log(
        catalog
          ? JSON.stringify(catalog, null, 2)
          : '(no catalog stored — the built-in lineup is in use)',
      );
      return 0;
    }
    case 'import': {
      if (!file) return fail('config catalog import <file>');
      const fs = await import('node:fs');
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch (err) {
        return fail(
          `cannot read ${file}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Array.isArray((parsed as { models?: unknown }).models)
      )
        return fail('the catalog needs a "models" array');
      models.setModelCatalog(parsed as object);
      console.log('model catalog imported (restart BearClaw to pick it up)');
      return 0;
    }
    default:
      return fail(`Unknown config catalog action: ${action}`);
  }
}

async function cmdWorkflows(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { replace: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const [action, target, out] = positionals;
  bootstrap();
  const store = await import('./store/workflows.js');
  const { parseDefinition, WorkflowValidationError } =
    await import('./workflows/schema.js');

  const describe = (err: unknown): string =>
    err instanceof WorkflowValidationError
      ? `${err.message}: ${err.issues.join('; ')}`
      : err instanceof Error
        ? err.message
        : String(err);

  switch (action) {
    case undefined:
    case 'list': {
      const rows = store.listWorkflowDefinitions();
      if (rows.length === 0) {
        console.log('(no workflows)');
        return 0;
      }
      const width = Math.max(...rows.map((r) => r.slug.length));
      for (const row of rows) {
        let label = '(unparseable)';
        try {
          const def = JSON.parse(row.definition) as { name?: string };
          label = def.name ?? '';
        } catch {
          // keep the placeholder
        }
        console.log(`${row.slug.padEnd(width)}  ${label}`);
      }
      return 0;
    }
    case 'export': {
      if (!target) return fail('workflows export <slug> [file]');
      const row = store.getWorkflowDefinition(target);
      if (!row) return fail(`Unknown workflow: ${target}`);
      let text: string;
      try {
        text = `${JSON.stringify(JSON.parse(row.definition), null, 2)}\n`;
      } catch {
        text = row.definition;
      }
      if (!out) {
        process.stdout.write(text);
        return 0;
      }
      const fs = await import('node:fs');
      fs.writeFileSync(out, text);
      console.log(`${target} written to ${out}`);
      return 0;
    }
    case 'import': {
      if (!target) return fail('workflows import <file> [--replace]');
      const fs = await import('node:fs');
      let def;
      try {
        def = parseDefinition(JSON.parse(fs.readFileSync(target, 'utf-8')));
      } catch (err) {
        return fail(describe(err));
      }
      if (!values.replace && store.getWorkflowDefinition(def.slug))
        return fail(`${def.slug} already exists (pass --replace to overwrite)`);
      store.putWorkflowDefinition(def.slug, def);
      console.log(`${def.slug} imported (restart BearClaw to pick it up)`);
      return 0;
    }
    default:
      return fail(`Unknown workflows action: ${action}`);
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
    case 'setup':
      return cmdSetup(rest);
    // No bootstrap(): doctor must report a missing database, not create one.
    case 'doctor':
      return cmdDoctor(rest);
    case 'export':
      return cmdExport(rest);
    case 'import':
      return cmdImport(rest);
    case 'migrate-fs':
      return cmdMigrateFs(rest);
    case 'config':
      return cmdConfig(rest);
    case 'workflows':
      return cmdWorkflows(rest);
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
