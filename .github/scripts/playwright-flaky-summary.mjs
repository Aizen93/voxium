#!/usr/bin/env node
// Lists every end-to-end test that failed and then passed on a retry.
//
// CI retries a failed test twice (playwright.config.ts), so a test that fails
// at random passes the gate, and the only trace of it was a line in a long log
// and an annotation among others. This reads the JSON reports of the
// end-to-end steps and, for each such test (Playwright's "flaky" outcome):
//   - prints a `::warning` annotation on the test's own file and line;
//   - adds a row to the job summary ($GITHUB_STEP_SUMMARY): the run, the
//     test, the failed attempts, the first error.
// With none, the summary says so and gives the counts. It never fails the
// job: whether a flaky test should is a separate decision. A report that is
// missing (its step never finished) or unreadable is said in both places.
//
// Usage: node playwright-flaky-summary.mjs "<label>=<report.json>"...
// Paths in annotations are relative to the working directory (the checkout).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Workflow-command escaping (GitHub's toCommandValue / toCommandProperty). */
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
/** One line of a table cell: no pipe, no line break, bounded. */
const cell = (s, max = 200) => {
  const flat = stripAnsi(s).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Every test of a report with the titles of the describe blocks around it. */
function* testsOf(suite, titles = []) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) yield { spec, test, titles: [...titles, spec.title] };
  }
  for (const child of suite.suites ?? []) yield* testsOf(child, [...titles, child.title]);
}

function readReport(file) {
  if (!existsSync(file)) return { problem: 'no report (the step did not finish)' };
  try {
    return { report: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { problem: `unreadable report (${err instanceof Error ? err.message : err})` };
  }
}

const runs = process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('=');
  if (at <= 0) {
    console.error(`::error::playwright-flaky-summary: expected "<label>=<report.json>", got "${arg}"`);
    process.exit(2);
  }
  return { label: arg.slice(0, at), file: arg.slice(at + 1) };
});

const flaky = [];
const notes = [];
for (const { label, file } of runs) {
  const { report, problem } = readReport(file);
  if (problem) {
    console.log(`::warning title=Playwright report::${escapeData(`${label}: ${problem}: ${file}`)}`);
    notes.push(`${label}: ${problem}.`);
    continue;
  }
  // A report that parses but is not shaped like Playwright's (another
  // reporter version, a truncated write that still parses) is said like an
  // unreadable one: this step reports, it must not throw.
  try {
    const rootDir = report.config?.rootDir ?? process.cwd();
    for (const suite of report.suites ?? []) {
      // The file-level suite's title is the file name: not part of the test's title
      for (const { spec, test, titles } of testsOf(suite)) {
        if (test.status !== 'flaky') continue;
        const results = test.results ?? [];
        const failed = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
        const passed = results.find((r) => r.status === 'passed');
        const firstError = failed.map((r) => r.error?.message ?? r.errors?.[0]?.message).find(Boolean) ?? '';
        flaky.push({
          label,
          file: path.relative(process.cwd(), path.resolve(rootDir, spec.file)).replace(/\\/g, '/'),
          line: spec.line,
          title: titles.join(' › '),
          project: test.projectName,
          failedAttempts: failed.length,
          passedOnRetry: passed?.retry,
          firstError: stripAnsi(firstError).split('\n').find((l) => l.trim()) ?? '',
        });
      }
    }
    const s = report.stats ?? {};
    notes.push(`${label}: ${s.expected ?? 0} passed, ${s.flaky ?? 0} flaky, ${s.unexpected ?? 0} failed, ${s.skipped ?? 0} skipped.`);
  } catch (err) {
    const why = `report not understood (${err instanceof Error ? err.message : err})`;
    console.log(`::warning title=Playwright report::${escapeData(`${label}: ${why}: ${file}`)}`);
    notes.push(`${label}: ${why}.`);
  }
}

for (const t of flaky) {
  const title = `Flaky test (${t.label})`;
  const message = `${t.title} failed ${t.failedAttempts} time(s), then passed on retry ${t.passedOnRetry}: ${t.firstError}`;
  console.log(`::warning file=${escapeProperty(t.file)},line=${t.line},title=${escapeProperty(title)}::${escapeData(message)}`);
}
console.log(
  flaky.length === 0
    ? 'No end-to-end test needed a retry.'
    : `${flaky.length} end-to-end test(s) passed only on a retry: listed in the job summary.`,
);

const summary = ['## End-to-end tests that passed only on a retry', ''];
if (flaky.length === 0) {
  summary.push('None: every test passed at its first attempt.', '');
} else {
  summary.push(
    `${flaky.length} test(s) failed and then passed on a retry. The job still passes; each one is a flake to fix or to tag @quarantine.`,
    '',
    '| Run | Test | Failed attempts | First error |',
    '| --- | --- | --- | --- |',
    ...flaky.map(
      (t) => `| ${cell(t.label)} | \`${cell(`${t.file}:${t.line}`)}\` ${cell(t.title)} | ${t.failedAttempts} | ${cell(t.firstError)} |`,
    ),
    '',
  );
}
summary.push(...notes.map((n) => `- ${n}`), '');

const target = process.env.GITHUB_STEP_SUMMARY;
if (target) {
  try {
    appendFileSync(target, `${summary.join('\n')}\n`);
  } catch (err) {
    console.log(`::warning::could not write the job summary: ${escapeData(err instanceof Error ? err.message : err)}`);
  }
} else {
  console.log(summary.join('\n'));
}
