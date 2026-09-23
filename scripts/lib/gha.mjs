// Tiny helpers for talking to the GitHub Actions runner.
// Everything degrades gracefully when run locally (no GITHUB_* env vars).
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export function warning(message) {
  log(`::warning::${escapeData(message)}`);
}

export function error(message) {
  log(`::error::${escapeData(message)}`);
}

export function notice(message) {
  log(`::notice::${escapeData(message)}`);
}

/** Set a step output (multi-line safe). */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!file) {
    log(`[output] ${name}=${text}`);
    return;
  }
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

/** Append markdown to the job summary. */
export function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    log(markdown);
    return;
  }
  appendFileSync(file, `${markdown}\n`);
}

/**
 * Run a CLI entry point: prints a clean ::error:: annotation instead of a stack
 * trace for expected failures, and exits non-zero.
 */
export async function main(fn) {
  try {
    await fn();
  } catch (err) {
    error(err?.message ?? String(err));
    if (process.env.RUNNER_DEBUG === '1' && err?.stack) log(err.stack);
    process.exitCode = 1;
  }
}

/** Read a required env var or throw a readable error. */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
