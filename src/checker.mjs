import { open, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const pointer = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const child = (path, key) => `${path}/${pointer(key)}`;
const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

function preservesSecretSlots(expected, actual, marker) {
  const pieces = expected.split(marker);
  const first = pieces[0];
  const last = pieces.at(-1);
  if (!actual.startsWith(first) || !actual.endsWith(last)) return false;
  let cursor = first.length;
  const end = actual.length - last.length;
  for (const piece of pieces.slice(1, -1)) {
    const index = actual.indexOf(piece, cursor);
    if (index < 0 || index + piece.length > end) return false;
    cursor = index + piece.length;
  }
  return cursor <= end;
}

// ASCII-only sentinels: tolerate malformed unrelated escapes without hiding markers.
function percentDecode(value) {
  return value.replace(/%([a-f\d]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(value) {
  const compact = value.replace(/[\t\n\r ]/g, '');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) throw new Error('Non-canonical base64');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Expected UTF-8 fixture body');
  return text;
}

function parseUniqueJson(text) {
  const value = JSON.parse(text);
  // JSON.parse silently keeps the last duplicate member. Reject such inputs so
  // a discarded field cannot hide a marker. JSON.parse validates grammar first;
  // this lexical pass only tracks object keys, including escaped spellings.
  const objects = [];
  const keySuffix = /\s*:/y;
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}]/g)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else {
      keySuffix.lastIndex = match.index + token.length;
      if (keySuffix.test(text)) {
        const key = JSON.parse(token);
        if (objects.at(-1).has(key)) throw new SyntaxError('Duplicate JSON object member');
        objects.at(-1).add(key);
      }
    }
  }
  return value;
}

/** Check only this corpus contract. Passing is never a real-data safety decision. */
export function checkFixture(candidate, baseline, fixture, markers) {
  const issues = [];
  const report = (kind, path, detail) => {
    if (issues.length < 50) issues.push({ kind, path: path || '/', detail });
  };

  function scanString(value, path) {
    let decoded = value;
    const found = new Set();
    for (let round = 0; round <= 2; round++) {
      for (const [index, marker] of markers.entries()) {
        if (decoded.includes(marker) && !found.has(index)) {
          found.add(index);
          report('sentinel', path, `Known synthetic marker #${index + 1} remains`);
        }
      }
      decoded = percentDecode(decoded);
    }
  }

  function scan(value, path = '', depth = 0) {
    if (depth > MAX_DEPTH) return report('structure', path, 'Maximum nesting exceeded');
    if (typeof value === 'string') return scanString(value, path);
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      scanString(key, `${child(path, key)} (key)`);
      scan(item, child(path, key), depth + 1);
    }
    // HAR response.content base64; only the declared encoding is interpreted.
    if (value.encoding === 'base64' && typeof value.text === 'string') {
      try { scanString(decodeBase64(value.text), `${path}/text (base64)`); }
      catch { report('encoding', `${path}/text`, 'Expected canonical base64 of UTF-8 fixture text'); }
    }
    if (typeof value.mimeType === 'string' && value.mimeType.split(';')[0].trim() === 'application/json' && typeof value.text === 'string') {
      try { scan(parseUniqueJson(value.text), `${path}/text (json)`, depth + 1); }
      catch { report('encoding', `${path}/text`, 'Expected JSON fixture text with unique object keys'); }
    }
  }

  function compare(expected, actual, path = '', depth = 0, codecApplied = false) {
    if (depth > MAX_DEPTH) return report('structure', path, 'Maximum nesting exceeded');
    if (type(expected) !== type(actual)) return report('structure', path, `Expected ${type(expected)}`);
    if (typeof expected === 'string') {
      const codec = codecApplied ? undefined : fixture.codecs[path];
      if (codec) {
        try {
          const decode = { percent: percentDecode, base64: decodeBase64, json: parseUniqueJson }[codec];
          compare(decode(expected), decode(actual), path, depth + 1, true);
        } catch { report('encoding', path, `Invalid ${codec} fixture value`); }
        return;
      }
      if (expected.includes(fixture.marker)) {
        // Only secret slots can change. All surrounding benign text stays intact.
        if (!preservesSecretSlots(expected, actual, fixture.marker)) report('preservation', path, 'Non-secret text changed');
      } else if (actual !== expected) report('preservation', path, 'Non-secret value changed');
      return;
    }
    if (Array.isArray(expected)) {
      if (actual.length !== expected.length) report('structure', path, 'Fixture array length changed');
      expected.forEach((item, index) => compare(item, actual[index], child(path, index), depth + 1));
    } else if (expected !== null && typeof expected === 'object') {
      for (const key of Object.keys(expected)) {
        if (!Object.hasOwn(actual, key)) report('structure', child(path, key), 'Required fixture field missing');
        else compare(expected[key], actual[key], child(path, key), depth + 1);
      }
      for (const key of Object.keys(actual)) {
        if (!Object.hasOwn(expected, key)) report('structure', child(path, key), 'Unexpected fixture field');
      }
    } else if (actual !== expected) report('preservation', path, 'Non-secret value changed');
  }

  scan(candidate);
  compare(baseline, candidate);
  return { id: fixture.id, file: fixture.file, passed: issues.length === 0, issues };
}

async function readCandidate(path) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not-file');
    if (stat.size > MAX_BYTES) throw new Error('too-large');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > MAX_BYTES) throw new Error('too-large');
    return parseUniqueJson(buffer.subarray(0, count).toString('utf8'));
  } finally { await handle.close(); }
}

export async function loadCorpus() {
  const manifest = JSON.parse(await readFile(join(root, 'fixtures/manifest.json'), 'utf8'));
  const cases = await Promise.all(manifest.cases.map(async fixture => ({
    ...fixture, baseline: await readCandidate(join(root, 'fixtures/raw', fixture.file))
  })));
  return { cases, markers: cases.map(fixture => fixture.marker) };
}

export async function checkDirectory(directory) {
  const files = await readdir(directory);
  const { cases, markers } = await loadCorpus();
  const results = [];
  for (const fixture of cases) {
    try {
      const candidate = await readCandidate(join(directory, fixture.file));
      results.push(checkFixture(candidate, fixture.baseline, fixture, markers));
    } catch (error) {
      const detail = error.code === 'ENOENT' ? 'Fixture file missing'
        : error.message === 'too-large' ? 'Fixture exceeds 1 MiB limit'
        : error instanceof SyntaxError ? 'Invalid JSON'
        : 'Cannot read fixture file';
      results.push({ id: fixture.id, file: fixture.file, passed: false, issues: [{ kind: 'input', path: '/', detail }] });
    }
  }
  const names = new Set(cases.map(fixture => fixture.file));
  const unexpected = files.filter(file => file.endsWith('.har') && !names.has(file)).length;
  if (unexpected) results.push({ id: 'unexpected-files', passed: false, issues: [{ kind: 'input', path: '/', detail: `${unexpected} unexpected .har file(s)` }] });
  const passed = results.filter(result => result.passed).length;
  return {
    schemaVersion: 1,
    scope: 'Known synthetic markers and this corpus preservation contract only; not real-data safety certification.',
    total: results.length, passed, failed: results.length - passed, results
  };
}
