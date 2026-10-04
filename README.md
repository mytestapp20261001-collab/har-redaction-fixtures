# HAR redaction fixtures

A small, offline regression corpus for checking whether a HAR sanitizer removes **known synthetic secrets** without gutting the surrounding fixture. Twelve original input/reference pairs, a zero-dependency Node checker, and regression tests.

Licensed under the [MIT License](LICENSE). Run directly from this repository; no package installation is needed. `package.json` is marked private to prevent accidental npm publication.

## What a pass means

A pass means the twelve known markers were absent in the supported representations and the candidate preserved this corpus's structure and benign data. **It does not mean a real HAR is safe to share.** This project is a test corpus and checker, not a sanitizer, general secret detector, complete HAR validator, or security certification.

All fixtures are invented. They contain no browser captures, real credentials, personal data, or usable authentication tokens. The `example.test` addresses are test data. Do not use real HARs with this checker or put them in this repository.

## Run locally

Use Node.js 22 or newer. No install step, dependencies, network access, account, or API key is needed. These commands run from the project directory:

```sh
node --test
node bin/check.mjs fixtures/reference
node bin/check.mjs fixtures/raw --json
```

Expected results:

- Tests pass, including a raw-fails/reference-passes matrix
- Reference: `12/12 passed; 0 failed.`, exit code **0**
- Raw: JSON with `total: 12`, `passed: 0`, `failed: 12`, exit code **1**; this failure is intentional

To exercise your own sanitizer, process each file in `fixtures/raw/` and save the outputs under the **same filenames** in a separate `candidate/` directory. Keep the bundled inputs and manifest unchanged. Then run:

```sh
node bin/check.mjs candidate
node bin/check.mjs candidate --json
```

The checker only reads local files. It neither executes your sanitizer nor modifies its inputs. It has no fetch calls, telemetry, tracking, or service integration.

Exit codes are **0** for all fixtures passing, **1** for fixture/input failures, and **2** for incorrect arguments or inability to load the directory/bundled corpus. JSON result reports go to stdout; JSON setup/usage errors go to stderr. Human reports show fixture IDs, paths, and failure types, not captured field values. At most 50 issues per fixture are reported.

## The twelve cases

| Fixture | Secret locations |
| --- | --- |
| `auth-header` | Authorization request header |
| `cookie-header` | Cookie request header, alongside a benign cookie |
| `cookie-arrays` | Request and response cookie arrays |
| `set-cookie` | Set-Cookie response header, preserving attributes |
| `custom-auth-header` | X-Api-Key request header |
| `url-query` | URL and queryString array copies |
| `percent-encoded-query` | Fully percent-encoded URL value and parsed copy |
| `form-params` | Form postData.params |
| `json-request-body` | A nested token in JSON postData.text |
| `text-response` | Embedded token in response text |
| `base64-response` | UTF-8 response text declared as base64 |
| `repeated-marker` | Repeated token within a value and across several fields |

`fixtures/manifest.json` lists each marker, description, and field-specific decoding contract. Reference outputs use `[REDACTED]`; other replacements can pass. The references are expected examples, not an included general redaction algorithm.

## Preservation contract and limits

The checker compares candidates with the bundled raw fixtures. It requires every original key, scalar type, array element, and array order. It rejects added fields, changed benign values, empty replacement objects, and deleted required fields. Only known secret slots can change. Surrounding public text, request methods/routes, public query values, status, cookie attributes, MIME types, and metadata stay intact.

This is intentionally stricter than HAR validity. A sanitizer that legitimately removes headers, drops bodies, reorders arrays, recomputes metadata, or minimizes unrelated fields may fail this contract. That is a preservation mismatch, not proof the sanitizer leaks. Both issue types are reported separately. Conversely, a pass is never proof that unknown private data was removed.

Supported inspection is bounded:

- Literal marker matching in JSON string values and keys
- Up to two rounds of ASCII `%XX` decoding for marker detection
- Canonical padded base64 (ASCII whitespace allowed) of UTF-8 text in objects declaring `encoding: "base64"`
- Parsed JSON text in objects with `mimeType: "application/json"` (optional MIME parameters allowed)
- Field-specific percent, JSON, or base64 decoding for preservation comparisons, as declared in the manifest
- Maximum 1 MiB per candidate file and 64 levels of inspected nesting

The suite does not cover every encoding, compressed/binary bodies, encrypted/hashed values, split or transformed markers, all authentication schemes, arbitrary PII, replayability, or Playwright trace ZIP files. Unknown secrets are not detected. A malicious transformation can evade a finite fixture test. Do not treat this as an adversarial security boundary.

Content size fields preserve the original synthetic recording metadata rather than pretending the reference is a new wire capture. The body contents themselves remain available in each expected reference.

Missing, malformed, or oversized required files fail. Duplicate object keys in outer HAR JSON or embedded JSON bodies also fail, including equivalent escaped keys; silently discarded duplicate fields must not hide a marker. Unexpected `.har` files fail; unrelated files are ignored. Keep a candidate directory dedicated to these twelve outputs. The bundled manifest and raw baselines are trusted test inputs: editing them changes the test, not the quality of your sanitizer.

## Maintain the corpus

The fixtures are generated deterministically from `scripts/generate-fixtures.mjs`:

```sh
node scripts/generate-fixtures.mjs
node --test
```

The generator writes only the bundled raw/reference files and manifest. Its deliberate marker replacement is limited to these invented recipes; do not adapt it into a claimed real-data sanitizer.

Tests cover the expected 12-fail/12-pass matrix, individual deletion of every fixture field, empty HARs, changed public fields, a single surviving repeated marker, encoded/escaped leaks, duplicate JSON keys, malformed inputs, CLI output/exit codes, and byte-for-byte regeneration. Tests create and clean temporary directories and regenerate the bundled fixtures for the determinism check.

## Why this exists

HAR sanitization already has prior art. [google/har-sanitizer](https://github.com/google/har-sanitizer) describes redaction across headers, cookies, parameters, and embedded content; that repository is archived. [Playwright issue #40533](https://github.com/microsoft/playwright/issues/40533) includes a request for trace sanitization motivated by sharing constraints. These are motivation for a small synthetic regression corpus, **not evidence that anyone uses or endorses this project**. A Playwright trace is also not the same artifact as a HAR. Sources checked October 4, 2026.

No source code or captured traffic from those projects is included here.

## Creator disclosure

Prepared by the creator of [MyTest](https://mytest.app). That is an optional promotional link. This tool works independently; no visit, account, or MyTest usage is required. There is no tracking or referral parameter in the link.
