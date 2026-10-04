// Original, deterministic, wholly synthetic data. This is not a real-data redactor.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const markerFor = id => `HARFIX_SYNTHETIC_${id.replaceAll('-', '_').toUpperCase()}_SECRET`;
const pct = value => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
const req = '/log/entries/0/request';
const res = '/log/entries/0/response';
const cases = [
  ['auth-header', 'Authorization request header', (entry, secret) => {
    entry.request.headers.push({ name: 'Authorization', value: `Bearer ${secret}` });
  }],
  ['cookie-header', 'Cookie request header with a benign cookie', (entry, secret) => {
    entry.request.headers.push({ name: 'Cookie', value: `session=${secret}; theme=light` });
  }],
  ['cookie-arrays', 'Both request and response cookie arrays', (entry, secret) => {
    entry.request.cookies.push({ name: 'session', value: secret });
    entry.response.cookies.push({ name: 'session', value: secret, path: '/', httpOnly: true, secure: true });
  }],
  ['set-cookie', 'Set-Cookie response header and attributes', (entry, secret) => {
    entry.response.headers.push({ name: 'Set-Cookie', value: `session=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax` });
  }],
  ['custom-auth-header', 'Application-specific X-Api-Key header', (entry, secret) => {
    entry.request.headers.push({ name: 'X-Api-Key', value: secret });
  }],
  ['url-query', 'Secret in both URL and queryString array', (entry, secret) => {
    entry.request.url += `?token=${secret}&view=compact`;
    entry.request.queryString.push({ name: 'token', value: secret }, { name: 'view', value: 'compact' });
  }],
  ['percent-encoded-query', 'Fully percent-encoded query value plus its parsed copy', (entry, secret) => {
    entry.request.url += `?token=${pct(secret)}&view=compact`;
    entry.request.queryString.push({ name: 'token', value: secret }, { name: 'view', value: 'compact' });
  }, { [`${req}/url`]: 'percent' }],
  ['form-params', 'HAR form postData.params values', (entry, secret) => {
    entry.request.method = 'POST';
    entry.request.postData = { mimeType: 'application/x-www-form-urlencoded', params: [
      { name: 'password', value: secret }, { name: 'mode', value: 'demo' }
    ] };
  }],
  ['json-request-body', 'Nested JSON request text with preserved public fields', (entry, secret) => {
    entry.request.method = 'POST';
    entry.request.postData = { mimeType: 'application/json', text: JSON.stringify({
      account: { token: secret, displayName: 'Synthetic Example' }, enabled: true
    }) };
  }, { [`${req}/postData/text`]: 'json' }],
  ['text-response', 'Secret embedded in response text', (entry, secret) => {
    entry.response.content.text = `Synthetic demo response: token=${secret}; result=ok`;
  }],
  ['base64-response', 'Secret in a HAR base64-encoded response body', (entry, secret) => {
    entry.response.content.encoding = 'base64';
    entry.response.content.text = Buffer.from(`Synthetic encoded response: token=${secret}; result=ok`).toString('base64');
  }, { [`${res}/content/text`]: 'base64' }],
  ['repeated-marker', 'One marker repeated within and across fields', (entry, secret) => {
    entry.request.headers.push({ name: 'Authorization', value: `Bearer ${secret}` });
    entry.request.url += `?token=${secret}&again=${secret}`;
    entry.request.queryString.push({ name: 'token', value: secret }, { name: 'again', value: secret });
    entry.response.content.text = `first=${secret}; second=${secret}; result=ok`;
  }]
];

function makeHar(id, secret, setup) {
  const entry = {
    startedDateTime: '2026-01-01T00:00:00.000Z', time: 12,
    request: {
      method: 'GET', url: 'https://example.test/resource', httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Accept', value: 'application/json' }], cookies: [], queryString: [],
      headersSize: -1, bodySize: -1
    },
    response: {
      status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], cookies: [],
      content: { size: 0, mimeType: 'text/plain', text: 'Synthetic public response' },
      redirectURL: '', headersSize: -1, bodySize: -1
    },
    cache: {}, timings: { send: 1, wait: 10, receive: 1 }
  };
  setup(entry, secret);
  const body = entry.response.content;
  body.size = Buffer.byteLength(body.encoding === 'base64' ? Buffer.from(body.text, 'base64') : body.text);
  return { log: { version: '1.2', creator: { name: 'har-redaction-fixtures', version: '0.1.0' }, comment: `Synthetic fixture: ${id}`, entries: [entry] } };
}

await mkdir(join(root, 'fixtures/raw'), { recursive: true });
await mkdir(join(root, 'fixtures/reference'), { recursive: true });
const manifest = { version: 1, cases: [] };
for (const [id, description, setup, codecs = {}] of cases) {
  const marker = markerFor(id);
  const raw = makeHar(id, marker, setup);
  const reference = makeHar(id, '[REDACTED]', setup);
  // These are recorded transfer-size metadata, not a rewritten transport capture.
  reference.log.entries[0].response.content.size = raw.log.entries[0].response.content.size;
  const file = `${id}.har`;
  for (const [directory, value] of [['raw', raw], ['reference', reference]]) {
    await writeFile(join(root, 'fixtures', directory, file), `${JSON.stringify(value, null, 2)}\n`);
  }
  manifest.cases.push({ id, file, description, marker, codecs });
}
await writeFile(join(root, 'fixtures/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${manifest.cases.length} synthetic raw/reference fixture pairs.`);
