/**
 * @module output
 *
 * Output formatting helpers for the CLI.
 * Supports both human-readable table output and machine-readable JSON.
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import type Decimal from 'decimal.js';
import type { Stream, StreamBalances } from '@canton-streams/sdk';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Format a Decimal for display (up to 6 decimal places). */
export function fmtDecimal(d: Decimal): string {
  return d.toFixed(6).replace(/\.?0+$/, '') || '0';
}

/** Format a Date for display. */
export function fmtDate(date: Date | undefined): string {
  if (!date) return '-';
  return date.toISOString().replace('T', ' ').replace(/\.000Z$/, 'Z');
}

/** Colour a stream status string. */
export function fmtStatus(status: string): string {
  switch (status) {
    case 'Active':
      return chalk.green(status);
    case 'Completed':
      return chalk.blue(status);
    case 'Cancelled':
      return chalk.red(status);
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Stream table
// ---------------------------------------------------------------------------

/** Print an array of streams as a table. */
export function printStreamTable(streams: Stream[]): void {
  if (streams.length === 0) {
    console.log(chalk.yellow('No streams found.'));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold('Stream ID'),
      chalk.bold('Sender'),
      chalk.bold('Recipient'),
      chalk.bold('Amount'),
      chalk.bold('Vesting'),
      chalk.bold('Status'),
      chalk.bold('Start'),
      chalk.bold('End'),
    ],
    wordWrap: true,
  });

  for (const s of streams) {
    table.push([
      s.config.streamId,
      s.config.sender,
      s.config.recipient,
      fmtDecimal(s.config.totalDeposited),
      s.config.vestingMode.mode,
      fmtStatus(s.state.status),
      fmtDate(s.config.startTime),
      fmtDate(s.config.endTime),
    ]);
  }

  console.log(table.toString());
}

// ---------------------------------------------------------------------------
// Stream detail
// ---------------------------------------------------------------------------

/** Print detailed stream info (config + state + balances). */
export function printStreamDetail(stream: Stream, balances: StreamBalances): void {
  console.log();
  console.log(chalk.bold.underline('Stream Configuration'));
  const configTable = new Table();
  configTable.push(
    { 'Stream ID': stream.config.streamId },
    { 'Contract ID': stream.contractId },
    { 'Sender': stream.config.sender },
    { 'Recipient': stream.config.recipient },
    { 'Total Deposited': fmtDecimal(stream.config.totalDeposited) },
    { 'Start Time': fmtDate(stream.config.startTime) },
    { 'End Time': fmtDate(stream.config.endTime) },
    { 'Vesting Mode': stream.config.vestingMode.mode },
    { 'Cancellable': stream.config.cancellable ? chalk.green('Yes') : chalk.red('No') },
  );
  console.log(configTable.toString());

  console.log();
  console.log(chalk.bold.underline('Stream State'));
  const stateTable = new Table();
  stateTable.push(
    { 'Status': fmtStatus(stream.state.status) },
    { 'Total Withdrawn': fmtDecimal(stream.state.totalWithdrawn) },
    { 'Last Withdraw': fmtDate(stream.state.lastWithdrawTime) },
    { 'Renewal Count': String(stream.state.renewalCount) },
  );
  console.log(stateTable.toString());

  console.log();
  console.log(chalk.bold.underline('Balances') + chalk.dim(' (display-only estimates)'));
  const balTable = new Table();
  balTable.push(
    { 'Accrued': fmtDecimal(balances.accrued) },
    { 'Withdrawable': fmtDecimal(balances.withdrawable) },
    { 'Refundable': fmtDecimal(balances.refundable) },
    { 'Already Withdrawn': fmtDecimal(balances.alreadyWithdrawn) },
    { 'Percent Complete': `${balances.percentComplete}%` },
  );
  console.log(balTable.toString());
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

/** Print any value as formatted JSON. */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, jsonReplacer, 2));
}

/** JSON replacer that handles Decimal and Date. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && 'toFixed' in value && typeof (value as any).toFixed === 'function') {
    return (value as Decimal).toString();
  }
  return value;
}
