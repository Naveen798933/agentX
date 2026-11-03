import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../src/llm/geminiClient.js';
import { SoftwareSynthesizer } from '../src/core/softwareSynthesizer.js';

describe('LLM Resilience, Rate-Limit Backoff & Resilient Code Recovery Suite', () => {
  test('1. GeminiClient enforces sliding-window rate limit without exceeding RPM ceiling', async () => {
    const client = new GeminiClient({ apiKey: 'mock-key', simulationMode: false, maxRequestsPerMinute: 3 });
    assert.equal(client.maxRequestsPerMinute, 3);
    assert.deepEqual(client.requestTimestamps, []);

    // Record 3 mock timestamps
    const now = Date.now();
    client.requestTimestamps = [now - 20000, now - 10000, now - 5000];

    // Simulate rate limiter check
    await client._enforceRateLimit();
    // Verify requestTimestamps maintained
    assert.equal(client.requestTimestamps.length, 3);
    client._recordRequestTimestamp();
    assert.equal(client.requestTimestamps.length, 4);
  });

  test('2. SoftwareSynthesizer recovers core files from truncated JSON response', () => {
    const synthesizer = new SoftwareSynthesizer();
    const truncatedPayload = `{
      "apiJs": "import { DatabaseSync } from 'node:sqlite';\\nexport function getStatus() { return { status: 'ONLINE' }; }",
      "testJs": "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\ntest('status', () => assert.ok(true));",
      "indexHtml": "<!DOCTYPE html><html><body><h1>Dashboard</h1></body></html>",
      "styleCss": "body { margin: 0; background: #0f172a; font-family:
    `;

    const parsed = synthesizer._parseSynthesizedOutput(truncatedPayload);
    assert.ok(parsed.apiJs, 'Should recover apiJs');
    assert.ok(parsed.apiJs.includes('DatabaseSync'), 'Should have content');
    assert.ok(parsed.testJs, 'Should recover testJs');
    assert.ok(parsed.indexHtml, 'Should recover indexHtml');
  });

  test('3. SoftwareSynthesizer preserves regex escape patterns (\\d, \\s, \\w) in synthesized code', () => {
    const synthesizer = new SoftwareSynthesizer();
    const regexPayload = `{
      "apiJs": "export const emailPattern = /\\w+@[a-zA-Z_]+?\\.[a-zA-Z]{2,3}/;\\nexport const pin = /\\d{6}/;",
      "testJs": "import { test } from 'node:test'; test('ok', () => {});",
      "indexHtml": "<!DOCTYPE html><html><body>Test</body></html>"
    }`;

    const parsed = synthesizer._parseSynthesizedOutput(regexPayload);
    assert.ok(parsed.apiJs.includes('\\w+'), 'Preserves \\w+ regex escape');
    assert.ok(parsed.apiJs.includes('\\d{6}'), 'Preserves \\d escape');
  });

  test('4. SoftwareSynthesizer recovers code when model outputs markdown code blocks', () => {
    const synthesizer = new SoftwareSynthesizer();
    const markdownPayload = `Here are the files for the project:

\`\`\`js
// src/api.js
import { DatabaseSync } from 'node:sqlite';
export const db = new DatabaseSync(':memory:');
\`\`\`

\`\`\`js
// tests/api.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('database ready', () => assert.ok(true));
\`\`\`

\`\`\`html
<!-- public/index.html -->
<!DOCTYPE html>
<html><head><title>App</title></head><body><h1>Live App</h1></body></html>
\`\`\`

\`\`\`css
/* public/style.css */
body { background: #111; color: #fff; }
\`\`\`
`;

    const parsed = synthesizer._parseSynthesizedOutput(markdownPayload);
    assert.ok(parsed.apiJs.includes('DatabaseSync'), 'Extracted apiJs from markdown fence');
    assert.ok(parsed.testJs.includes('database ready'), 'Extracted testJs from markdown fence');
    assert.ok(parsed.indexHtml.includes('Live App'), 'Extracted indexHtml from markdown fence');
    assert.ok(parsed.styleCss.includes('#111'), 'Extracted styleCss from markdown fence');
  });

  test('5. SoftwareSynthesizer recovers string with embedded raw newlines', () => {
    const synthesizer = new SoftwareSynthesizer();
    const rawNewlinePayload = `{
      "apiJs": "import { DatabaseSync } from 'node:sqlite';
export function calculate(a, b) {
  return a + b;
}",
      "testJs": "import { test } from 'node:test';
test('pass', () => {});",
      "indexHtml": "<!DOCTYPE html>
<html>
  <body>App</body>
</html>"
    }`;

    const parsed = synthesizer._parseSynthesizedOutput(rawNewlinePayload);
    assert.ok(parsed.apiJs.includes('calculate(a, b)'), 'Extracted multiline apiJs');
    assert.ok(parsed.testJs.includes('test('), 'Extracted multiline testJs');
    assert.ok(parsed.indexHtml.includes('App'), 'Extracted multiline indexHtml');
  });
});
