import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type VoidAppContext } from '../../src/server/app.js';

describe('Object Lifecycle, Archaeology History, and Persistent Database Survival', () => {
  let tmpDataDir: string;
  let ctx: VoidAppContext | null = null;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thevoid-db-test-'));
  });

  afterEach(async () => {
    if (ctx) {
      await ctx.app.close();
      ctx = null;
    }
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('supports complete object lifecycle, revision archaeology, independent copying, and deletion', async () => {
    ctx = await createApp({
      nodeEnv: 'test',
      pgliteDataDir: tmpDataDir,
      seedInitialObject: false
    });

    // 1. Create an object
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 100,
        y: 200,
        width: 400,
        height: 300,
        html: '<h1>Artifact Alpha</h1>',
        css: 'h1 { color: #c8a24e; }',
        javascript: 'console.log("alpha v1");'
      }
    });
    expect(createRes.statusCode).toBe(201);
    const createdBody = createRes.json();
    const objId = createdBody.object.id;
    expect(objId).toBeTruthy();
    expect(createdBody.object.revision).toBe(1);
    expect(createdBody.revision.eventType).toBe('created');

    // 2. Read its state via GET /api/objects/:id and GET /api/region
    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/objects/${objId}`
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().object.html).toBe('<h1>Artifact Alpha</h1>');

    const regionRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/region?minX=0&minY=0&maxX=600&maxY=600'
    });
    expect(regionRes.statusCode).toBe(200);
    expect(regionRes.json().objects).toHaveLength(1);
    expect(regionRes.json().objects[0].id).toBe(objId);

    // 3. Update HTML, CSS, JS, Move, and Resize across revisions
    const patchCodeRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/objects/${objId}`,
      payload: {
        html: '<h1>Artifact Alpha v2</h1>',
        css: 'h1 { color: #ffffff; }',
        javascript: 'console.log("alpha v2");'
      }
    });
    expect(patchCodeRes.statusCode).toBe(200);
    expect(patchCodeRes.json().object.revision).toBe(2);
    expect(patchCodeRes.json().revision.eventType).toBe('updated');

    const moveRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/objects/${objId}`,
      payload: {
        x: 500,
        y: -300
      }
    });
    expect(moveRes.statusCode).toBe(200);
    expect(moveRes.json().object.revision).toBe(3);
    expect(moveRes.json().object.x).toBe(500);
    expect(moveRes.json().object.y).toBe(-300);
    expect(moveRes.json().revision.eventType).toBe('moved');

    const resizeRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/objects/${objId}`,
      payload: {
        width: 640,
        height: 480
      }
    });
    expect(resizeRes.statusCode).toBe(200);
    expect(resizeRes.json().object.revision).toBe(4);
    expect(resizeRes.json().object.width).toBe(640);
    expect(resizeRes.json().object.height).toBe(480);
    expect(resizeRes.json().revision.eventType).toBe('resized');

    // 4. Inspect historical revisions (Archaeology)
    const revListRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/objects/${objId}/revisions`
    });
    expect(revListRes.statusCode).toBe(200);
    const revList = revListRes.json().revisions;
    expect(revList).toHaveLength(4);
    expect(revList.map((r: { revision: number }) => r.revision)).toEqual([4, 3, 2, 1]);

    // Fetch historical revision 1 detail
    const rev1Res = await ctx.app.inject({
      method: 'GET',
      url: `/api/objects/${objId}/revisions/1`
    });
    expect(rev1Res.statusCode).toBe(200);
    const rev1 = rev1Res.json().revision;
    expect(rev1.html).toBe('<h1>Artifact Alpha</h1>');
    expect(rev1.css).toBe('h1 { color: #c8a24e; }');

    // 5. Copy historical source into an independent Object B
    const copyRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: 550,
        y: -250,
        width: rev1.width,
        height: rev1.height,
        html: rev1.html,
        css: rev1.css,
        javascript: rev1.javascript
      }
    });
    expect(copyRes.statusCode).toBe(201);
    const copyObj = copyRes.json().object;
    expect(copyObj.id).not.toBe(objId);
    expect(copyObj.revision).toBe(1);
    expect(copyObj.html).toBe('<h1>Artifact Alpha</h1>');

    // 6. Delete original Object A; verify Object B is untouched and Object A is gone from active world
    const delRes = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/objects/${objId}`
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().objectId).toBe(objId);

    const getDeletedActive = await ctx.app.inject({
      method: 'GET',
      url: `/api/objects/${objId}`
    });
    expect(getDeletedActive.statusCode).toBe(404);

    // Cannot edit a deleted object
    const patchDeleted = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/objects/${objId}`,
      payload: { html: '<p>resurrect</p>' }
    });
    expect(patchDeleted.statusCode).toBe(410);

    // Copy Object B remains active and independent
    const getCopyRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/objects/${copyObj.id}`
    });
    expect(getCopyRes.statusCode).toBe(200);
    expect(getCopyRes.json().object.html).toBe('<h1>Artifact Alpha</h1>');

    // Archaeology on deleted Object A still works!
    const deletedHistoryRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/objects/${objId}/revisions`
    });
    expect(deletedHistoryRes.statusCode).toBe(200);
    expect(deletedHistoryRes.json().object.deleted).toBe(true);
    expect(deletedHistoryRes.json().revisions).toHaveLength(5); // includes final 'deleted' revision
  });

  it('persists active objects, revisions, and deleted state across full server restarts', async () => {
    // Start Server Instance #1
    ctx = await createApp({
      nodeEnv: 'test',
      pgliteDataDir: tmpDataDir,
      seedInitialObject: false
    });

    const createActive = await ctx.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: -1200,
        y: 3400,
        html: '<div>Survivor</div>',
        css: 'div { color: cyan; }',
        javascript: ''
      }
    });
    const survivorId = createActive.json().object.id;

    const createDoomed = await ctx.app.inject({
      method: 'POST',
      url: '/api/objects',
      payload: {
        x: -1100,
        y: 3400,
        html: '<div>Temporary</div>',
        css: '',
        javascript: ''
      }
    });
    const doomedId = createDoomed.json().object.id;

    // Delete the second object before restart
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/objects/${doomedId}`
    });

    // Shut down Server Instance #1 completely
    await ctx.app.close();
    ctx = null;

    // Start Server Instance #2 pointing to the exact same disk directory
    ctx = await createApp({
      nodeEnv: 'test',
      pgliteDataDir: tmpDataDir,
      seedInitialObject: true // Should NOT re-seed because database already has objects
    });

    const regionRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/region?minX=-2000&minY=3000&maxX=0&maxY=4000'
    });
    expect(regionRes.statusCode).toBe(200);
    const objects = regionRes.json().objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].id).toBe(survivorId);
    expect(objects[0].html).toBe('<div>Survivor</div>');

    // Verify deleted object did NOT reappear after restart
    const checkDoomed = await ctx.app.inject({
      method: 'GET',
      url: `/api/objects/${doomedId}`
    });
    expect(checkDoomed.statusCode).toBe(404);
  });
});
