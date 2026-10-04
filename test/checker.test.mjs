import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDirectory, checkFixture, loadCorpus, root } from '../src/checker.mjs';

const { cases, markers } = await loadCorpus();
const reference = async fixture => JSON.parse(await readFile(join(root, 'fixtures/reference', fixture.file), 'utf8'));
const pct = value => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
const check = (fixture, candidate) => checkFixture(candidate, fixture.baseline, fixture, markers);
const get = id => cases.find(fixture => fixture.id === id);
const entry = har => har.log.entries[0];
const cli = args => spawnSync(process.execPath, ['bin/check.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('exactly twelve raw fixtures fail on markers, with no preservation errors', async () => {
  assert.equal(cases.length, 12);
  assert.equal(new Set(markers).size, 12);
  const report = await checkDirectory(join(root, 'fixtures/raw'));
  assert.deepEqual([report.total, report.passed, report.failed], [12, 0, 12]);
  for (const result of report.results) {
    assert.ok(result.issues.length > 0, result.id);
    assert.ok(result.issues.every(issue => issue.kind === 'sentinel'), result.id);
  }
});

test('all twelve reference fixtures pass', async () => {
  const report = await checkDirectory(join(root, 'fixtures/reference'));
  assert.deepEqual([report.total, report.passed, report.failed], [12, 12, 0]);
});

for (const fixture of cases) {
  test(`${fixture.id}: deleting every existing field individually fails`, async () => {
    const clean = await reference(fixture);
    const paths = [];
    function walk(value, path = []) {
      if (value === null || typeof value !== 'object') return;
      for (const key of Object.keys(value)) {
        paths.push([...path, key]);
        walk(value[key], [...path, key]);
      }
    }
    walk(clean);
    for (const path of paths) {
      const candidate = structuredClone(clean);
      const parent = path.slice(0, -1).reduce((value, key) => value[key], candidate);
      if (Array.isArray(parent)) parent.splice(Number(path.at(-1)), 1);
      else delete parent[path.at(-1)];
      assert.equal(check(fixture, candidate).passed, false, path.join('/'));
    }
  });
}

test('empty objects and deleted entries cannot masquerade as redaction', async () => {
  const fixture = cases[0];
  for (const candidate of [{}, { log: {} }, { log: { entries: [] } }]) {
    assert.equal(check(fixture, candidate).passed, false);
  }
  const candidate = await reference(fixture);
  candidate.log.entries = [];
  assert.equal(check(fixture, candidate).passed, false);
});

test('preserves method, URL route, status, header names, and public JSON fields', async () => {
  const fixture = get('json-request-body');
  const mutations = [
    har => { entry(har).request.method = 'DELETE'; },
    har => { entry(har).request.url = 'https://other.test/'; },
    har => { entry(har).response.status = 500; },
    har => { entry(har).request.headers[0].name = 'Other'; },
    har => { entry(har).request.postData.text = '{}'; },
    har => { entry(har).request.postData.text = '{"account":{"token":"hidden"},"enabled":true}'; }
  ];
  for (const mutate of mutations) {
    const candidate = await reference(fixture);
    mutate(candidate);
    assert.equal(check(fixture, candidate).passed, false);
  }
});

test('allows another redaction token and JSON body whitespace', async () => {
  const fixture = get('json-request-body');
  const candidate = await reference(fixture);
  const body = JSON.parse(entry(candidate).request.postData.text);
  body.account.token = '<removed>';
  entry(candidate).request.postData.text = JSON.stringify(body, null, 2);
  assert.equal(check(fixture, candidate).passed, true);
});

test('one remaining occurrence of a repeated marker fails', async () => {
  const fixture = get('repeated-marker');
  const candidate = await reference(fixture);
  entry(candidate).response.content.text = `first=[REDACTED]; second=${fixture.marker}; result=ok`;
  const report = check(fixture, candidate);
  assert.equal(report.passed, false);
  assert.ok(report.issues.some(issue => issue.kind === 'sentinel'));
});

test('finds percent-encoded markers, including twice encoded and malformed neighboring escape', async () => {
  const fixture = get('percent-encoded-query');
  for (const encoded of [pct(fixture.marker), pct(pct(fixture.marker)), `%bad%${pct(fixture.marker)}`]) {
    const candidate = await reference(fixture);
    entry(candidate).request.url = `https://example.test/resource?token=${encoded}&view=compact`;
    assert.ok(check(fixture, candidate).issues.some(issue => issue.kind === 'sentinel'));
  }
});

test('finds JSON Unicode-escaped marker after parsing the declared JSON body', async () => {
  const fixture = get('json-request-body');
  const candidate = await reference(fixture);
  entry(candidate).request.postData.text = entry(fixture.baseline).request.postData.text.replace('HARFIX', '\\u0048ARFIX');
  assert.ok(check(fixture, candidate).issues.some(issue => issue.kind === 'sentinel'));
});

test('duplicate JSON body members cannot conceal an escaped marker', async () => {
  const fixture = get('json-request-body');
  for (const duplicateKey of ['token', '\\u0074oken']) {
    const candidate = await reference(fixture);
    entry(candidate).request.postData.text = `{"account":{"token":"\\u0048ARFIX_SYNTHETIC_JSON_REQUEST_BODY_SECRET","${duplicateKey}":"[REDACTED]","displayName":"Synthetic Example"},"enabled":true}`;
    const result = check(fixture, candidate);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(issue => issue.kind === 'encoding'));
  }
});

test('duplicate outer HAR members cannot conceal a marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'har-duplicates-test-'));
  try {
    await cp(join(root, 'fixtures/reference'), directory, { recursive: true });
    const fixture = get('auth-header');
    const clean = await readFile(join(directory, fixture.file), 'utf8');
    for (const duplicateKey of ['headers', '\\u0068eaders']) {
      const candidate = clean.replace('"headers": [', `"${duplicateKey}": [{"name":"Authorization","value":"Bearer ${fixture.marker}"}], "headers": [`);
      await writeFile(join(directory, fixture.file), candidate);
      const result = await checkDirectory(directory);
      assert.equal(result.failed, 1);
      assert.equal(result.results[0].issues[0].detail, 'Invalid JSON');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('finds base64 marker after wrapping; rejects invalid encoding', async () => {
  const fixture = get('base64-response');
  const candidate = await reference(fixture);
  entry(candidate).response.content.text = entry(fixture.baseline).response.content.text.match(/.{1,20}/g).join('\n');
  assert.ok(check(fixture, candidate).issues.some(issue => issue.kind === 'sentinel'));
  entry(candidate).response.content.text = '%%%';
  assert.ok(check(fixture, candidate).issues.some(issue => issue.kind === 'encoding'));
});

test('finds a different case marker in a secret slot', async () => {
  const fixture = get('custom-auth-header');
  const candidate = await reference(fixture);
  entry(candidate).request.headers[1].value = markers[0];
  assert.ok(check(fixture, candidate).issues.some(issue => issue.kind === 'sentinel'));
});

test('does not let a blank URL or altered benign text pass', async () => {
  const fixture = get('url-query');
  for (const url of ['', 'https://example.test/resource?token=hidden&view=expanded', 'https://example.test/resource?token=hidden&view=compact\n']) {
    const candidate = await reference(fixture);
    entry(candidate).request.url = url;
    assert.equal(check(fixture, candidate).passed, false);
  }
});

test('CLI has human/JSON output and documented exit codes', () => {
  const clean = cli(['fixtures/reference']);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /12\/12 passed; 0 failed/);
  const dirty = cli(['fixtures/raw', '--json']);
  assert.equal(dirty.status, 1);
  assert.equal(JSON.parse(dirty.stdout).failed, 12);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['--help']).status, 0);
  assert.equal(cli(['fixtures/reference', '--typo']).status, 2);
  const missing = cli(['this-directory-does-not-exist', '--json']);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr).error, 'setup');
});

test('missing, malformed, oversized, and extra fixture files fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'har-fixtures-test-'));
  try {
    await cp(join(root, 'fixtures/reference'), directory, { recursive: true });
    await rm(join(directory, cases[0].file));
    await writeFile(join(directory, cases[1].file), '{ broken');
    await writeFile(join(directory, cases[2].file), ' '.repeat(1024 * 1024 + 1));
    await writeFile(join(directory, 'unexpected.har'), '{}');
    const report = await checkDirectory(directory);
    assert.equal(report.failed, 4);
    assert.equal(report.results[0].issues[0].detail, 'Fixture file missing');
    assert.equal(report.results[1].issues[0].detail, 'Invalid JSON');
    assert.equal(report.results[2].issues[0].detail, 'Fixture exceeds 1 MiB limit');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('generator is byte-for-byte deterministic', async () => {
  const snapshot = async () => {
    const files = ['manifest.json'];
    for (const directory of ['raw', 'reference']) {
      for (const file of (await readdir(join(root, 'fixtures', directory))).sort()) files.push(`${directory}/${file}`);
    }
    return Promise.all(files.map(async file => [file, await readFile(join(root, 'fixtures', file), 'utf8')]));
  };
  const before = await snapshot();
  const run = spawnSync(process.execPath, ['scripts/generate-fixtures.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(await snapshot(), before);
});
