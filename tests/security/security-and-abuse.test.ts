import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type VoidAppContext } from '../../src/server/app.js';

describe('Infrastructure Security, Validation, Origin Checks, and Abuse Protection', () => {
  let ctx: VoidAppContext | null = null;

  beforeEach(async () => {
    ctx = await createApp({
      nodeEnv: 'test',
      pgliteDataDir: 'memory://',
      seedInitialObject: false,
      maxHtmlBytes: 2048,
      maxPayloadBytes: 16384,
      maxWsMessageBytes: 4096,
      rateLimitCreatesPerMin: 5,
      allowedOrigins: ['http://localhost:3000']
    });
  });

  afterEach(async () => {
    if (ctx) {
      await ctx.app.close();
      ctx = null;
    }
  });

  it('rejects oversized source code and oversized HTTP payloads with 413', async () => {
    const hugeHtml = '<div>' + 'A'.repeat(4000) + '</div>';
    const res = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 0,
        y: 0,
        html: hugeHtml
      }
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('SOURCE_TOO_LARGE');

    const hugeRawPayload = JSON.stringify({
      x: 0,
      y: 0,
      html: 'B'.repeat(20_000)
    });
    const rawRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: { 'content-type': 'application/json' },
      payload: hugeRawPayload
    });
    expect(rawRes.statusCode).toBe(413);
  });

  it('rejects malformed JSON, prototype pollution keys, and invalid coordinates/IDs', async () => {
    const badJsonRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: { 'content-type': 'application/json' },
      payload: '{"x": 0, "y": '
    });
    expect(badJsonRes.statusCode).toBe(400);

    const protoPollutionRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      headers: { 'content-type': 'application/json' },
      payload: '{"x":0,"y":0,"__proto__":{"polluted":true}}'
    });
    expect(protoPollutionRes.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const outOfRangeRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 999_999_999,
        y: 0
      }
    });
    expect(outOfRangeRes.statusCode).toBe(400);
    expect(outOfRangeRes.json().error.code).toBe('COORDINATE_OUT_OF_RANGE');

    const invalidIdRes = await ctx!.app.inject({
      method: 'GET',
      url: '/api/objects/../../etc/passwd'
    });
    expect([400, 404]).toContain(invalidIdRes.statusCode);
  });

  it('neutralizes SQL injection attempts in object IDs and source payloads via parameterized queries', async () => {
    const sqlInjectionId = "1' OR '1'='1'; DROP TABLE world_objects; --";
    const getRes = await ctx!.app.inject({
      method: 'GET',
      url: `/api/objects/${encodeURIComponent(sqlInjectionId)}`
    });
    expect(getRes.statusCode).toBe(400);

    const createRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 10,
        y: 20,
        html: "'; DROP TABLE world_objects; --",
        css: "/* '; DELETE FROM object_revisions; -- */",
        javascript: "const q = `SELECT * FROM world_objects`;"
      }
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().object;
    expect(created.html).toBe("'; DROP TABLE world_objects; --");

    // Verify database table is completely intact
    const healthRes = await ctx!.app.inject({
      method: 'GET',
      url: '/api/health'
    });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().activeObjects).toBe(1);
  });

  it('enforces WebSocket origin validation and rejects null (sandboxed iframe) or untrusted origins', async () => {
    const addr = await ctx!.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = addr.replace(/^http/, 'ws') + '/ws';

    const expectRejectedWs = (origin: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(wsUrl, {
          headers: { Origin: origin }
        });
        ws.on('error', (err) => {
          resolve(err.message);
        });
        ws.on('close', (code) => {
          resolve(`closed:${code}`);
        });
      });

    // 1. Untrusted external origin is rejected (403 upgrade rejection or 1008 policy violation)
    const evilOutcome = await expectRejectedWs('https://attacker.evil.example');
    expect(evilOutcome).toMatch(/403|1008/);

    // 2. 'null' origin (e.g. a sandboxed iframe attempting to open a WebSocket back to host) is rejected
    const nullOutcome = await expectRejectedWs('null');
    expect(nullOutcome).toMatch(/403|1008/);

    // 3. Allowed origin succeeds
    const validWs = new WebSocket(wsUrl, {
      headers: { Origin: 'http://localhost:3000' }
    });
    const welcome = await new Promise<{ type: string }>((resolve, reject) => {
      validWs.once('message', (data) => resolve(JSON.parse(data.toString())));
      validWs.once('error', reject);
    });
    expect(welcome.type).toBe('WELCOME');
    validWs.close();
  });

  it('enforces creation flood rate limits while allowing immediate single-object deletions without cooldown', async () => {
    // Create 5 objects (up to the configured 5/min test limit)
    const createdIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await ctx!.app.inject({
        method: 'POST',
        url: '/api/objects',
        payload: { x: i * 100, y: 0, html: `<p>${i}</p>` }
      });
      expect(res.statusCode).toBe(201);
      createdIds.push(res.json().object.id);
    }

    // 6th creation in the same minute is rate-limited (429)
    const sixthRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: { x: 600, y: 0, html: '<p>flood</p>' }
    });
    expect(sixthRes.statusCode).toBe(429);
    expect(sixthRes.json().error.code).toBe('RATE_LIMIT_EXCEEDED');

    // Immediate deletion of created objects works without any per-object cooldown
    for (const id of createdIds) {
      const delRes = await ctx!.app.inject({
        method: 'DELETE',
        url: `/api/objects/${id}`
      });
      expect(delRes.statusCode).toBe(200);
    }
  });
});
