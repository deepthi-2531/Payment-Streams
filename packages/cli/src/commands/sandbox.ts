/**
 * @module commands/sandbox
 *
 * `canton-streams sandbox` — Start a local Canton sandbox for development.
 *
 * Bootstraps a complete local development environment:
 *  1. Verifies Canton/dpm installation
 *  2. (Optionally) resets any running sandbox
 *  3. Starts a Canton sandbox process
 *  4. Waits for the gRPC port to become ready
 *  5. Builds Daml packages if needed
 *  6. Uploads the DAR file to the sandbox
 *  7. Allocates test parties
 *  8. Writes a local CLI config file
 *  9. Prints a setup summary
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import ora from 'ora';

interface SandboxArgs {
  port: number;
  parties: string[];
  upload: boolean;
  reset: boolean;
}

export const command = 'sandbox';
export const describe = 'Start a local Canton sandbox for development';

export function builder(yargs: Argv): Argv<SandboxArgs> {
  return yargs
    .option('port', {
      type: 'number',
      default: 6865,
      describe: 'gRPC port for the Canton sandbox',
    })
    .option('parties', {
      type: 'array',
      string: true,
      default: ['Alice', 'Bob', 'Charlie'],
      describe: 'Test parties to allocate',
    })
    .option('upload', {
      type: 'boolean',
      default: true,
      describe: 'Upload the DAR file after sandbox starts (use --no-upload to skip)',
    })
    .option('reset', {
      type: 'boolean',
      default: false,
      describe: 'Stop any existing sandbox before starting a new one',
    }) as unknown as Argv<SandboxArgs>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a command synchronously and return trimmed stdout, or null on failure. */
function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/** Wait until a TCP connection can be established on localhost:port. */
function waitForPort(port: number, timeoutMs: number = 60_000): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for port ${port} after ${timeoutMs / 1000}s`));
        return;
      }
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

/** Kill a process tree with best-effort fallback. */
function killProcess(child: ChildProcess): void {
  try {
    // Attempt to kill the process group (negative PID)
    if (child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // Fallback: kill just the child
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead
    }
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handler(argv: ArgumentsCamelCase<SandboxArgs>): Promise<void> {
  const port = argv.port;
  const parties = argv.parties as string[];
  const shouldUpload = argv.upload;
  const shouldReset = argv.reset;

  let sandboxProcess: ChildProcess | null = null;

  // ---- Cleanup handler ----
  function cleanup() {
    if (sandboxProcess) {
      console.log(chalk.yellow('\nShutting down Canton sandbox...'));
      killProcess(sandboxProcess);
      sandboxProcess = null;
    }
  }

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  console.log();
  console.log(chalk.bold.underline('Canton Sandbox Bootstrap'));
  console.log();

  // ── Step 1: Check Canton / dpm installation ──────────────────────────

  const step1 = ora('Checking Canton/dpm installation...').start();
  const dpmVersion = tryExec('dpm --version');
  if (!dpmVersion) {
    step1.fail(chalk.red('Canton/dpm is not installed or not on PATH'));
    console.log();
    console.log(chalk.yellow('To install Canton and dpm:'));
    console.log(chalk.dim('  https://docs.daml.com/canton/usermanual/installation.html'));
    console.log();
    console.log(chalk.yellow('Make sure the `dpm` and `canton` binaries are on your PATH.'));
    console.log();
    process.exit(1);
  }
  step1.succeed(`Canton/dpm found: ${chalk.cyan(dpmVersion)}`);

  // ── Step 2: Reset existing sandbox if requested ──────────────────────

  if (shouldReset) {
    const stepReset = ora('Stopping existing sandbox...').start();
    tryExec(`canton sandbox --port ${port} --stop`);
    // Also attempt a direct kill on the port (best effort)
    tryExec(`lsof -ti :${port} | xargs kill -9 2>/dev/null`);
    // Brief pause to let the port release
    await new Promise((resolve) => setTimeout(resolve, 1000));
    stepReset.succeed('Existing sandbox stopped');
  }

  // ── Step 3: Start Canton sandbox ─────────────────────────────────────

  const step3 = ora(`Starting Canton sandbox on port ${port}...`).start();

  sandboxProcess = spawn('canton', ['sandbox', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // so we can kill the process group
  });

  // Forward sandbox output to the console (after the spinner resolves)
  let sandboxOutputBuffer: string[] = [];
  let sandboxForwarding = false;

  sandboxProcess.stdout?.on('data', (data: Buffer) => {
    const line = data.toString();
    if (sandboxForwarding) {
      process.stdout.write(chalk.dim(`  [sandbox] ${line}`));
    } else {
      sandboxOutputBuffer.push(line);
    }
  });

  sandboxProcess.stderr?.on('data', (data: Buffer) => {
    const line = data.toString();
    if (sandboxForwarding) {
      process.stderr.write(chalk.dim(`  [sandbox] ${line}`));
    } else {
      sandboxOutputBuffer.push(line);
    }
  });

  sandboxProcess.on('error', (err) => {
    step3.fail(chalk.red(`Failed to start Canton sandbox: ${err.message}`));
    if (err.message.includes('ENOENT')) {
      console.log(chalk.yellow('The `canton` binary was not found on your PATH.'));
    }
    process.exit(1);
  });

  sandboxProcess.on('exit', (code, signal) => {
    if (sandboxProcess) {
      // Unexpected exit
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      console.error(chalk.red(`\nCanton sandbox exited unexpectedly (${reason})`));
      sandboxProcess = null;
    }
  });

  // ── Step 4: Wait for sandbox gRPC port ───────────────────────────────

  try {
    await waitForPort(port, 90_000);
    step3.succeed(`Canton sandbox running on port ${chalk.cyan(String(port))}`);
  } catch (err) {
    step3.fail(chalk.red('Canton sandbox failed to start'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    if (sandboxOutputBuffer.length > 0) {
      console.log(chalk.yellow('\nSandbox output:'));
      for (const line of sandboxOutputBuffer.slice(-20)) {
        process.stderr.write(chalk.dim(`  ${line}`));
      }
    }
    cleanup();
    process.exit(1);
  }

  // Start forwarding sandbox output now that the spinner is done
  sandboxForwarding = true;

  // ── Step 5: Build Daml packages ──────────────────────────────────────

  if (shouldUpload) {
    const step5 = ora('Building Daml packages...').start();

    // Check if a .dar file already exists
    const darPath = join(process.cwd(), '.daml', 'dist');
    const darExists = existsSync(darPath);

    if (darExists) {
      step5.text = 'Building Daml packages (incremental)...';
    }

    const buildResult = tryExec('dpm build --all');
    if (buildResult === null) {
      step5.warn('dpm build --all failed — attempting to continue with existing artifacts');
    } else {
      step5.succeed('Daml packages built');
    }

    // ── Step 6: Upload DAR file ──────────────────────────────────────

    const step6 = ora('Uploading DAR to sandbox...').start();

    // Try dpm-based upload first, fall back to canton CLI
    let uploadSuccess = false;
    const dpmUpload = tryExec(`dpm deploy --port ${port}`);
    if (dpmUpload !== null) {
      uploadSuccess = true;
    } else {
      // Fallback: find .dar files and upload via canton CLI
      const darFiles = tryExec('find . -name "*.dar" -path "*/.daml/dist/*" | head -5');
      if (darFiles) {
        for (const darFile of darFiles.split('\n').filter(Boolean)) {
          const result = tryExec(
            `canton ledger upload-dar --host localhost --port ${port} ${darFile}`,
          );
          if (result !== null) {
            uploadSuccess = true;
          }
        }
      }
    }

    if (uploadSuccess) {
      step6.succeed('DAR uploaded to sandbox');
    } else {
      step6.warn('DAR upload failed — you may need to upload manually');
    }
  } else {
    console.log(chalk.dim('  Skipping DAR upload (--no-upload)'));
  }

  // ── Step 7: Allocate test parties ────────────────────────────────────

  const step7 = ora(`Allocating parties: ${parties.join(', ')}...`).start();
  const allocatedParties: string[] = [];
  const failedParties: string[] = [];

  for (const party of parties) {
    const result = tryExec(
      `canton ledger allocate-parties --host localhost --port ${port} --parties ${party}`,
    );
    if (result !== null) {
      allocatedParties.push(party);
    } else {
      // Try alternative dpm-based allocation
      const altResult = tryExec(
        `dpm ledger allocate-party --port ${port} --party ${party}`,
      );
      if (altResult !== null) {
        allocatedParties.push(party);
      } else {
        failedParties.push(party);
      }
    }
  }

  if (failedParties.length === 0) {
    step7.succeed(`Parties allocated: ${chalk.cyan(allocatedParties.join(', '))}`);
  } else if (allocatedParties.length > 0) {
    step7.warn(
      `Some parties allocated (${chalk.cyan(allocatedParties.join(', '))})` +
        ` — failed: ${chalk.red(failedParties.join(', '))}`,
    );
  } else {
    step7.warn('Party allocation failed — you may need to allocate manually');
  }

  // ── Step 8: Write local config file ──────────────────────────────────

  const step8 = ora('Writing CLI config...').start();
  const configPath = join(homedir(), '.canton-streams.yaml');
  const defaultParty = allocatedParties[0] ?? parties[0];

  const configContent = [
    '# Canton Streams CLI configuration',
    `# Generated by "canton-streams sandbox" on ${new Date().toISOString()}`,
    '',
    `host: localhost`,
    `port: ${port}`,
    `party: ${defaultParty}`,
    '',
  ].join('\n');

  try {
    writeFileSync(configPath, configContent, 'utf-8');
    step8.succeed(`Config written to ${chalk.cyan(configPath)}`);
  } catch (err) {
    step8.warn(`Could not write config: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 9: Print summary ────────────────────────────────────────────

  console.log();
  console.log(chalk.bold.green('Sandbox is ready!'));
  console.log();
  console.log(`  ${chalk.bold('gRPC endpoint:')}  localhost:${port}`);
  console.log(`  ${chalk.bold('Parties:')}         ${allocatedParties.length > 0 ? allocatedParties.join(', ') : parties.join(', ') + chalk.dim(' (unconfirmed)')}`);
  console.log(`  ${chalk.bold('Default party:')}   ${defaultParty}`);
  console.log(`  ${chalk.bold('Config file:')}     ${configPath}`);
  console.log();
  console.log(chalk.dim('Try it out:'));
  console.log(chalk.green(`  canton-streams list --party ${defaultParty}`));
  console.log(chalk.green(`  canton-streams create --sender ${parties[0]} --recipient ${parties[1] ?? parties[0]} --amount 1000 --start-time $(date -Iseconds) --end-time $(date -v+30d -Iseconds)`));
  console.log();
  console.log(chalk.dim('Press Ctrl+C to stop the sandbox.'));
  console.log();

  // Keep the process alive — the sandbox runs in the foreground
  await new Promise<void>((resolve) => {
    if (sandboxProcess) {
      sandboxProcess.on('exit', () => {
        resolve();
      });
    } else {
      resolve();
    }
  });
}
