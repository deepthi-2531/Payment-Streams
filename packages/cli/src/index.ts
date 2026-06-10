#!/usr/bin/env node

/**
 * @canton-streams/cli
 *
 * CLI tool for Canton Payment Streams.
 *
 * @license Apache-2.0
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import * as create from './commands/create.js';
import * as list from './commands/list.js';
import * as inspect from './commands/inspect.js';
import * as withdraw from './commands/withdraw.js';
import * as cancel from './commands/cancel.js';
import * as renew from './commands/renew.js';
import * as batch from './commands/batch.js';
import * as sandbox from './commands/sandbox.js';

yargs(hideBin(process.argv))
  .scriptName('canton-streams')
  .usage('$0 <command> [options]')

  // Global connection options
  .option('host', {
    type: 'string',
    describe: 'Canton participant host',
    global: true,
  })
  .option('port', {
    type: 'number',
    describe: 'Canton participant gRPC port',
    global: true,
  })
  .option('tls', {
    type: 'boolean',
    describe: 'Use TLS for the connection',
    global: true,
  })
  // The JWT token is NOT accepted as a CLI flag. A `--token eyJ...`
  // argument is visible to any local user via `ps` / /proc/<pid>/cmdline
  // and is persisted to shell history. Supply it through the
  // CANTON_TOKEN environment variable instead.
  .option('party', {
    type: 'string',
    describe: 'Canton party to act as',
    global: true,
  })

  // Register commands
  .command(create)
  .command(list)
  .command(inspect)
  .command(withdraw)
  .command(cancel)
  .command(renew)
  .command(batch)
  .command(sandbox)

  .demandCommand(1, 'You must specify a command')
  .strict()
  .help()
  .alias('h', 'help')
  .version()
  .alias('v', 'version')
  .epilogue('Config: ~/.canton-streams.yaml | Env: CANTON_HOST, CANTON_PORT, CANTON_TOKEN, CANTON_PARTY')
  .parse();
