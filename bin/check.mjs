#!/usr/bin/env node
import { checkDirectory } from '../src/checker.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: node bin/check.mjs <candidate-directory> [--json]';
const json = args.includes('--json');
const directories = args.filter(arg => !arg.startsWith('--'));
if (args.length === 1 && args[0] === '--help') {
  console.log(`${usage}\nOffline synthetic regression check. Exit 0: pass; 1: fixture failure; 2: usage/setup error.`);
} else if (directories.length !== 1 || args.filter(arg => arg === '--json').length > 1 || args.some(arg => arg.startsWith('--') && arg !== '--json')) {
  console.error(json ? JSON.stringify({ error: 'usage', message: usage }) : usage);
  process.exitCode = 2;
} else {
  try {
    const report = await checkDirectory(directories[0]);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const result of report.results) {
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id}`);
        for (const issue of result.issues) console.log(`  ${issue.kind}: ${issue.path}: ${issue.detail}`);
      }
      console.log(`\n${report.passed}/${report.total} passed; ${report.failed} failed.`);
      console.log(report.scope);
    }
    process.exitCode = report.failed ? 1 : 0;
  } catch {
    const message = 'Cannot load candidate directory or bundled corpus. Check the path and file permissions.';
    console.error(json ? JSON.stringify({ error: 'setup', message }) : message);
    process.exitCode = 2;
  }
}
