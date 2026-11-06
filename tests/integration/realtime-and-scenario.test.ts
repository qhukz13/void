import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type VoidAppContext } from '../../src/server/app.js';
import type { ServerWsMessage } from '../../src/shared/types.js';

class TestWsClient {
  public ws!: WebSocket;
  public messages: ServerWsMessage[] = [];
  private waiters: Array<{
    predicate: (msg: ServerWsMessage) => boolean;
    resolve: (msg: ServerWsMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly url: string) {}

  async connect(): Promise<ServerWsMessage> {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8')) as ServerWsMessage;
      this.messages.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.predicate(msg)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });

    return this.waitFor((m) => m.type === 'WELCOME');
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor<T extends ServerWsMessage = ServerWsMessage>(
    predicate: (msg: ServerWsMessage) => boolean,
    timeoutMs = 5000
  ): Promise<T> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing as T);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: resolve as (msg: ServerWsMessage) => void,
        reject,
        timer
      });
    });
  }

  clearMessages(): void {
    this.messages = [];
  }

  close(): void {
    try {
      this.ws.close();
    } catch (_) {}
  }
}

describe('Realtime Multi-Client Synchronization & Mandatory 10-Step Acceptance Scenario', () => {
  let tmpDataDir: string;
  let ctx: VoidAppContext | null = null;
  let wsUrl = '';
  let clients: TestWsClient[] = [];

  beforeEach(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoid-rt-test-'));
    ctx = await createApp({
      nodeEnv: 'test',
      pgliteDataDir: tmpDataDir,
      seedInitialObject: false
    });
    const addr = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = addr.replace(/^http/, 'ws') + '/ws';
  });

  afterEach(async () => {
    for (const c of clients) {
      c.close();
    }
    clients = [];
    if (ctx) {
      await ctx.app.close();
      ctx = null;
    }
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('executes the Mandatory 10-Step End-to-End Multi-Client Scenario (Clients A through G + Server Restart)', async () => {
    const clientA = new TestWsClient(wsUrl);
    const clientB = new TestWsClient(wsUrl);
    const clientC = new TestWsClient(wsUrl);
    const clientD = new TestWsClient(wsUrl);
    const clientE = new TestWsClient(wsUrl);
    const clientF = new TestWsClient(wsUrl);
    clients.push(clientA, clientB, clientC, clientD, clientE, clientF);

    await Promise.all([
      clientA.connect(),
      clientB.connect(),
      clientC.connect(),
      clientD.connect(),
      clientE.connect(),
      clientF.connect()
    ]);

    const originViewport = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
    for (const c of [clientA, clientB, clientC, clientD, clientE, clientF]) {
      c.send({ type: 'SUBSCRIBE_VIEWPORT', bounds: originViewport });
      await c.waitFor((m) => m.type === 'VIEWPORT_SNAPSHOT');
      c.clearMessages();
    }

    // === STEP 1: Creation ===
    // Client A creates <h1>HELLO</h1>
    clientA.send({
      type: 'CREATE_OBJECT',
      payload: {
        x: 0,
        y: 0,
        width: 360,
        height: 260,
        html: '<h1>HELLO</h1>',
        css: '',
        javascript: ''
      }
    });

    const bCreated = await clientB.waitFor(
      (m) => m.type === 'OBJECT_CREATED' && m.object.html === '<h1>HELLO</h1>'
    );
    expect(bCreated.type).toBe('OBJECT_CREATED');
    const originalId = (bCreated as Extract<ServerWsMessage, { type: 'OBJECT_CREATED' }>).object.id;

    // === STEP 2: Realtime update ===
    // Client B changes HTML to <h1>GOODBYE</h1>; Client A sees the update
    clientA.clearMessages();
    clientB.send({
      type: 'UPDATE_OBJECT',
      objectId: originalId,
      payload: {
        html: '<h1>GOODBYE</h1>'
      }
    });

    const aUpdated = await clientA.waitFor(
      (m) => m.type === 'OBJECT_UPDATED' && m.object.id === originalId && m.object.html === '<h1>GOODBYE</h1>'
    );
    expect(aUpdated.type).toBe('OBJECT_UPDATED');

    // === STEP 3: Styling ===
    // Client C adds h1 { animation: spin 1s infinite; }; everyone sees it
    clientA.clearMessages();
    clientB.clearMessages();
    const spinCss = 'h1 {\n  animation: spin 1s infinite;\n}';
    clientC.send({
      type: 'UPDATE_OBJECT',
      objectId: originalId,
      payload: {
        css: spinCss
      }
    });

    const [aStyled, bStyled] = await Promise.all([
      clientA.waitFor((m) => m.type === 'OBJECT_UPDATED' && m.object.css === spinCss),
      clientB.waitFor((m) => m.type === 'OBJECT_UPDATED' && m.object.css === spinCss)
    ]);
    expect(aStyled.type).toBe('OBJECT_UPDATED');
    expect(bStyled.type).toBe('OBJECT_UPDATED');

    // === STEP 4: Destruction (Broken JS) ===
    // Client D modifies JavaScript so the object breaks; world remains functional
    clientA.clearMessages();
    clientD.send({
      type: 'UPDATE_OBJECT',
      objectId: originalId,
      payload: {
        javascript: 'undefinedVariable.foo(); throw new Error("broken");'
      }
    });

    const aBroken = await clientA.waitFor(
      (m) =>
        m.type === 'OBJECT_UPDATED' &&
        m.object.id === originalId &&
        m.object.javascript.includes('undefinedVariable.foo()')
    );
    expect(aBroken.type).toBe('OBJECT_UPDATED');

    // Verify server and world remain healthy
    const healthRes = await ctx!.app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);

    // === STEP 5: Historical inspection ===
    // Client E inspects object's history and retrieves revision 3 (before D broke the JS)
    const historyRes = await ctx!.app.inject({
      method: 'GET',
      url: `/api/objects/${originalId}/revisions`
    });
    expect(historyRes.statusCode).toBe(200);
    const revisions = historyRes.json().revisions;
    expect(revisions.length).toBeGreaterThanOrEqual(4);

    const rev3Res = await ctx!.app.inject({
      method: 'GET',
      url: `/api/objects/${originalId}/revisions/3`
    });
    expect(rev3Res.statusCode).toBe(200);
    const rev3 = rev3Res.json().revision;
    expect(rev3.html).toBe('<h1>GOODBYE</h1>');
    expect(rev3.css).toBe(spinCss);
    expect(rev3.javascript).toBe('');

    // Verify there is NO restore action
    const restoreAttempt = await ctx!.app.inject({
      method: 'POST',
      url: `/api/objects/${originalId}/restore`
    });
    expect(restoreAttempt.statusCode).toBe(403);

    // === STEP 6: Independent copy ===
    // Client E creates a new object from the copied source of revision 3
    const createCopyRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 200,
        y: 150,
        width: rev3.width,
        height: rev3.height,
        html: rev3.html,
        css: rev3.css,
        javascript: rev3.javascript
      }
    });
    expect(createCopyRes.statusCode).toBe(201);
    const copiedObj = createCopyRes.json().object;
    expect(copiedObj.id).not.toBe(originalId);
    expect(copiedObj.html).toBe('<h1>GOODBYE</h1>');
    expect(copiedObj.css).toBe(spinCss);

    // === STEP 7: Deletion ===
    // Client F deletes the original object; Clients A and B see deletion; independent copy remains
    clientA.clearMessages();
    clientB.clearMessages();
    clientF.send({
      type: 'DELETE_OBJECT',
      objectId: originalId
    });

    const [aDeleted, bDeleted] = await Promise.all([
      clientA.waitFor((m) => m.type === 'OBJECT_DELETED' && m.objectId === originalId),
      clientB.waitFor((m) => m.type === 'OBJECT_DELETED' && m.objectId === originalId)
    ]);
    expect(aDeleted.type).toBe('OBJECT_DELETED');
    expect(bDeleted.type).toBe('OBJECT_DELETED');

    // === STEP 8: Persistence (Refresh) ===
    // Client G refreshes and loads region state
    const gRegionRes = await ctx!.app.inject({
      method: 'GET',
      url: '/api/region?minX=-1000&minY=-1000&maxX=1000&maxY=1000'
    });
    expect(gRegionRes.statusCode).toBe(200);
    const activeObjects = gRegionRes.json().objects;
    expect(activeObjects).toHaveLength(1);
    expect(activeObjects[0].id).toBe(copiedObj.id);

    // === STEP 9: Navigation ===
    // Client G travels far away (500,000, -500,000) and returns to origin
    const farRegionRes = await ctx!.app.inject({
      method: 'GET',
      url: '/api/region?minX=499000&minY=-501000&maxX=501000&maxY=-499000'
    });
    expect(farRegionRes.statusCode).toBe(200);
    expect(farRegionRes.json().objects).toHaveLength(0);

    const returnRegionRes = await ctx!.app.inject({
      method: 'GET',
      url: '/api/region?minX=-1000&minY=-1000&maxX=1000&maxY=1000'
    });
    expect(returnRegionRes.statusCode).toBe(200);
    expect(returnRegionRes.json().objects).toHaveLength(1);
    expect(returnRegionRes.json().objects[0].id).toBe(copiedObj.id);

    // === STEP 10: Restart ===
    // Restart backend completely on same database directory and reconnect Client A
    for (const c of clients) c.close();
    clients = [];
    await ctx!.app.close();
    ctx = null;

    ctx = await createApp({
      nodeEnv: 'test',
      pgliteDataDir: tmpDataDir,
      seedInitialObject: false
    });
    const newAddr = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const newWsUrl = newAddr.replace(/^http/, 'ws') + '/ws';

    const reconnectedClient = new TestWsClient(newWsUrl);
    clients.push(reconnectedClient);
    await reconnectedClient.connect();
    reconnectedClient.send({ type: 'SUBSCRIBE_VIEWPORT', bounds: originViewport });

    const snapshot = await reconnectedClient.waitFor((m) => m.type === 'VIEWPORT_SNAPSHOT');
    expect(snapshot.type).toBe('VIEWPORT_SNAPSHOT');
    if (snapshot.type === 'VIEWPORT_SNAPSHOT') {
      expect(snapshot.objects).toHaveLength(1);
      expect(snapshot.objects[0].id).toBe(copiedObj.id);
      expect(snapshot.objects[0].html).toBe('<h1>GOODBYE</h1>');
    }
  });

  it('scopes realtime broadcasts spatially so distant clients do not receive irrelevant events', async () => {
    const nearClient = new TestWsClient(wsUrl);
    const farClient = new TestWsClient(wsUrl);
    clients.push(nearClient, farClient);

    await Promise.all([nearClient.connect(), farClient.connect()]);

    nearClient.send({
      type: 'SUBSCRIBE_VIEWPORT',
      bounds: { minX: -500, minY: -500, maxX: 500, maxY: 500 }
    });
    farClient.send({
      type: 'SUBSCRIBE_VIEWPORT',
      bounds: { minX: 500_000, minY: 500_000, maxX: 502_000, maxY: 502_000 }
    });

    await Promise.all([
      nearClient.waitFor((m) => m.type === 'VIEWPORT_SNAPSHOT'),
      farClient.waitFor((m) => m.type === 'VIEWPORT_SNAPSHOT')
    ]);

    nearClient.clearMessages();
    farClient.clearMessages();

    // Create object at (0, 0)
    await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 0,
        y: 0,
        html: '<p>near origin</p>'
      }
    });

    const nearMsg = await nearClient.waitFor((m) => m.type === 'OBJECT_CREATED');
    expect(nearMsg.type).toBe('OBJECT_CREATED');

    // Far client should NOT have received OBJECT_CREATED
    await new Promise((r) => setTimeout(r, 100));
    expect(farClient.messages.some((m) => m.type === 'OBJECT_CREATED')).toBe(false);
  });

  it('handles concurrent simultaneous updates deterministically and preserves all revisions', async () => {
    const createRes = await ctx!.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 0,
        y: 0,
        html: '<p>initial</p>'
      }
    });
    const objId = createRes.json().object.id;

    // 10 simultaneous updates to the same object
    const updates = Array.from({ length: 10 }, (_, idx) =>
      ctx!.app.inject({
        method: 'PATCH',
        url: `/api/objects/${objId}`,
        payload: {
          html: `<p>concurrent update #${idx + 1}</p>`
        }
      })
    );

    const results = await Promise.all(updates);
    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }

    const revRes = await ctx!.app.inject({
      method: 'GET',
      url: `/api/objects/${objId}/revisions`
    });
    expect(revRes.statusCode).toBe(200);
    const body = revRes.json();
    // Initial revision 1 + 10 concurrent updates = revision 11
    expect(body.object.revision).toBe(11);
    expect(body.revisions).toHaveLength(11);
  });
});
