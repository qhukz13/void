import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';

interface StageReport {
  concurrency: number;
  connectedClients: number;
  operationsAttempted: number;
  operationsSucceeded: number;
  errors: number;
  durationMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 100) / 100;
}

async function runStage(baseUrl: string, wsUrl: string, concurrency: number): Promise<StageReport> {
  const startMs = performance.now();
  const latencies: number[] = [];
  let opsAttempted = 0;
  let opsSucceeded = 0;
  let errors = 0;

  const sockets: WebSocket[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async (_, idx) => {
      const ws = new WebSocket(wsUrl);
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });

      const regionOffset = (idx % 10) * 2000;
      ws.send(
        JSON.stringify({
          type: 'SUBSCRIBE_VIEWPORT',
          bounds: {
            minX: regionOffset - 1000,
            minY: -1000,
            maxX: regionOffset + 1000,
            maxY: 1000
          }
        })
      );
    })
  );

  // Each logical client performs a lifecycle sequence: create -> move -> update -> navigate -> (half delete)
  await Promise.all(
    sockets.map(async (ws, idx) => {
      const regionOffset = (idx % 10) * 2000;
      try {
        // 1. Create object
        opsAttempted++;
        const t0 = performance.now();
        const createRes = await fetch(`${baseUrl}/api/objects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            x: regionOffset + (idx % 20) * 20,
            y: (idx % 15) * 20,
            width: 300,
            height: 220,
            html: `<div id="load-${idx}">client ${idx}</div>`,
            css: `#load-${idx} { color: #c8a24e; }`,
            javascript: `const x = ${idx};`
          })
        });
        latencies.push(performance.now() - t0);
        if (!createRes.ok) {
          errors++;
          return;
        }
        opsSucceeded++;
        const created = (await createRes.json()) as { object: { id: string } };
        const objId = created.object.id;

        // 2. Move object
        opsAttempted++;
        const t1 = performance.now();
        const moveRes = await fetch(`${baseUrl}/api/objects/${objId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            x: regionOffset + 120,
            y: 180
          })
        });
        latencies.push(performance.now() - t1);
        if (moveRes.ok) opsSucceeded++;
        else errors++;

        // 3. Spatial navigation via WebSocket
        ws.send(
          JSON.stringify({
            type: 'CURSOR_MOVE',
            x: regionOffset + 50,
            y: 50
          })
        );

        // 4. Delete half of the created objects
        if (idx % 2 === 0) {
          opsAttempted++;
          const t2 = performance.now();
          const delRes = await fetch(`${baseUrl}/api/objects/${objId}`, {
            method: 'DELETE'
          });
          latencies.push(performance.now() - t2);
          if (delRes.ok) opsSucceeded++;
          else errors++;
        }
      } catch {
        errors++;
      }
    })
  );

  for (const ws of sockets) {
    try {
      ws.close();
    } catch (_) {}
  }

  latencies.sort((a, b) => a - b);
  return {
    concurrency,
    connectedClients: sockets.length,
    operationsAttempted: opsAttempted,
    operationsSucceeded: opsSucceeded,
    errors,
    durationMs: Math.round(performance.now() - startMs),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99)
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoid-loadtest-'));
  const ctx = await createApp({
    nodeEnv: 'test',
    pgliteDataDir: tmpDir,
    seedInitialObject: false,
    rateLimitHttpMax: 50_000,
    rateLimitCreatesPerMin: 10_000,
    rateLimitMutationsPerMin: 20_000,
    rateLimitDeletesPerMin: 10_000,
    maxWsConnectionsPerIp: 1000,
    maxTotalWsConnections: 2000
  });

  try {
    const baseUrl = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';

    const stages: StageReport[] = [];
    for (const concurrency of [10, 50, 100]) {
      const report = await runStage(baseUrl, wsUrl, concurrency);
      stages.push(report);
    }

    const healthRes = await fetch(`${baseUrl}/api/health`);
    const health = await healthRes.json();

    console.log(
      JSON.stringify(
        {
          status: 'completed',
          stages,
          finalHealth: health
        },
        null,
        2
      )
    );

    const totalErrors = stages.reduce((acc, s) => acc + s.errors, 0);
    if (totalErrors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await ctx.app.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

void main();
