import { describe, expect, it } from 'vitest';
import {
  WORLD_MAX_COORD,
  WORLD_MIN_COORD
} from '../../src/shared/constants.js';
import {
  buildSandboxSrcDoc,
  instrumentUserJavaScript
} from '../../src/shared/sandbox-builder.js';
import {
  boxesIntersect,
  clampCoord,
  clampZoom,
  computeInfiniteGridOffset,
  coordToChunkIndex,
  formatDeepLinkSearch,
  formatRelativeTime,
  getChunksForBounds,
  getViewportBounds,
  getVisibleSectorMarkers,
  parseDeepLinkParams,
  screenToWorld,
  worldToScreen,
  zoomAroundScreenPoint
} from '../../src/shared/spatial.js';

describe('Infinite World Spatial Model & Coordinates', () => {
  it('converts world coordinates to screen coordinates and back accurately under pan and zoom', () => {
    const camera = { x: 1450.5, y: -2890.25, zoom: 1.6 };
    const vw = 1440;
    const vh = 900;

    const screen = worldToScreen(1800, -2500, vw, vh, camera);
    const world = screenToWorld(screen.x, screen.y, vw, vh, camera);

    expect(world.x).toBeCloseTo(1800, 1);
    expect(world.y).toBeCloseTo(-2500, 1);
  });

  it('preserves focal world point under cursor during repeated zoom operations', () => {
    let camera = { x: -4200, y: 8900, zoom: 1.0 };
    const vw = 1280;
    const vh = 800;
    const focalScreenX = 320;
    const focalScreenY = 610;

    const initialWorldPoint = screenToWorld(focalScreenX, focalScreenY, vw, vh, camera);

    for (const nextZoom of [1.5, 2.25, 0.75, 0.25, 3.1, 1.0]) {
      camera = zoomAroundScreenPoint(camera, nextZoom, focalScreenX, focalScreenY, vw, vh);
      const afterWorldPoint = screenToWorld(focalScreenX, focalScreenY, vw, vh, camera);
      expect(afterWorldPoint.x).toBeCloseTo(initialWorldPoint.x, 0);
      expect(afterWorldPoint.y).toBeCloseTo(initialWorldPoint.y, 0);
    }
  });

  it('handles large positive and negative coordinates near world limits without instability', () => {
    const farPositive = clampCoord(WORLD_MAX_COORD - 500);
    const farNegative = clampCoord(WORLD_MIN_COORD + 500);
    expect(farPositive).toBe(WORLD_MAX_COORD - 500);
    expect(farNegative).toBe(WORLD_MIN_COORD + 500);

    expect(clampCoord(WORLD_MAX_COORD + 999999)).toBe(WORLD_MAX_COORD);
    expect(clampCoord(WORLD_MIN_COORD - 999999)).toBe(WORLD_MIN_COORD);
    expect(clampCoord(Number.NaN)).toBe(0);
    expect(clampZoom(-5)).toBe(1.0);

    // Verify floating-origin modular grid offset stays bounded at astronomical coordinates
    const gridAtBillion = computeInfiniteGridOffset(1440, 850_000_000_000, 1.0, 128);
    expect(gridAtBillion.gridSizePx).toBe(128);
    expect(gridAtBillion.offsetPx).toBeGreaterThanOrEqual(0);
    expect(gridAtBillion.offsetPx).toBeLessThan(128);

    // Verify procedural sector lattice generation at distant coordinates
    const farBounds = getViewportBounds({ x: 500_000_000, y: -500_000_000, zoom: 1 }, 1280, 800, 0.35);
    const sectors = getVisibleSectorMarkers(farBounds, 1.0);
    expect(sectors.length).toBeGreaterThan(0);
    expect(sectors[0].worldX).toBe(sectors[0].cx * 2048);
  });

  it('computes chunk indices and bounding box intersections across chunk boundaries', () => {
    expect(coordToChunkIndex(0)).toBe(0);
    expect(coordToChunkIndex(2047)).toBe(0);
    expect(coordToChunkIndex(2048)).toBe(1);
    expect(coordToChunkIndex(-1)).toBe(-1);
    expect(coordToChunkIndex(-2048)).toBe(-1);
    expect(coordToChunkIndex(-2049)).toBe(-2);

    const chunks = getChunksForBounds({
      minX: -100,
      minY: -100,
      maxX: 2100,
      maxY: 100
    });
    expect(chunks).toContain('-1:-1');
    expect(chunks).toContain('0:0');
    expect(chunks).toContain('1:0');

    const boxA = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    const boxB = { minX: 250, minY: 250, maxX: 500, maxY: 500 };
    const boxC = { minX: 301, minY: 0, maxX: 600, maxY: 300 };
    expect(boxesIntersect(boxA, boxB)).toBe(true);
    expect(boxesIntersect(boxA, boxC)).toBe(false);
  });

  it('parses and formats deep links with coordinates, zoom, and object IDs', () => {
    const parsed = parseDeepLinkParams('?x=1200&y=-850&zoom=1.25&object=abc-12345');
    expect(parsed).toEqual({
      x: 1200,
      y: -850,
      zoom: 1.25,
      objectId: 'abc-12345'
    });

    const formatted = formatDeepLinkSearch({ x: 1200, y: -850, zoom: 1.25 }, 'abc-12345');
    expect(formatted).toBe('?x=1200&y=-850&zoom=1.25&object=abc-12345');

    // Rejects malicious object IDs in deep link
    const malicious = parseDeepLinkParams('?x=0&y=0&object=<script>alert(1)</script>');
    expect(malicious.objectId).toBeUndefined();
  });

  it('formats relative anonymous timestamps accurately', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(formatRelativeTime('2026-10-27T11:59:58Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-10-27T11:59:42Z', now)).toBe('18 seconds ago');
    expect(formatRelativeTime('2026-10-27T11:57:00Z', now)).toBe('3 minutes ago');
    expect(formatRelativeTime('2026-10-27T10:00:00Z', now)).toBe('2 hours ago');
    expect(formatRelativeTime('2026-10-23T12:00:00Z', now)).toBe('4 days ago');
  });

  it('computes viewport bounds with margin', () => {
    const bounds = getViewportBounds({ x: 0, y: 0, zoom: 1 }, 1000, 800, 0.5);
    expect(bounds.minX).toBe(-750);
    expect(bounds.maxX).toBe(750);
    expect(bounds.minY).toBe(-600);
    expect(bounds.maxY).toBe(600);
  });
});

describe('Sandbox Isolation & Untrusted Code Instrumentation', () => {
  it('instruments infinite while(true) and for(;;) loops so they halt deterministically', () => {
    const whileRes = instrumentUserJavaScript('while (true) {}');
    expect(whileRes.syntaxError).toBeNull();
    expect(whileRes.code).toContain('__voidLoopGuard()');

    const forRes = instrumentUserJavaScript('for (;;) { let x = 1; }');
    expect(forRes.syntaxError).toBeNull();
    expect(forRes.code).toContain('__voidLoopGuard()');

    const bracelessRes = instrumentUserJavaScript('while (1);');
    expect(bracelessRes.syntaxError).toBeNull();
    expect(bracelessRes.code).toContain('__voidLoopGuard()');

    // Execute instrumented infinite loop with a mock guard that throws on 5th iteration
    let calls = 0;
    const fn = new Function(
      '__voidLoopGuard',
      whileRes.code
    );
    expect(() =>
      fn(() => {
        calls += 1;
        if (calls >= 5) throw new RangeError('Execution timeout');
        return true;
      })
    ).toThrow(/Execution timeout/);
    expect(calls).toBe(5);
  });

  it('detects JavaScript syntax errors prior to execution', () => {
    const bad = instrumentUserJavaScript('function broken( { return 1; ');
    expect(bad.syntaxError).not.toBeNull();
    expect(bad.syntaxError?.message).toBeTruthy();
  });

  it('does not corrupt while/for tokens inside string literals or comments', () => {
    const code = `
      // while (true) in a comment
      const str = "while (true) { for (;;) {} }";
      const tpl = \`for (;;) {}\`;
      let i = 0;
      while (i < 3) { i++; }
    `;
    const res = instrumentUserJavaScript(code);
    expect(res.syntaxError).toBeNull();
    expect(res.code).toContain('"while (true) { for (;;) {} }"');
    expect(res.code).toContain('while (__voidLoopGuard() && (i < 3))');
  });

  it('builds a strict CSP srcdoc that escapes </script> and </style> breakout attempts', () => {
    const srcdoc = buildSandboxSrcDoc({
      objectId: 'obj-123',
      revision: 4,
      html: '<h1>Hello</h1>',
      css: 'body { color: red; }</style><script>window.parent.hacked=1;</script>',
      javascript: 'const s = "</script><script>evil()";'
    });

    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("frame-src 'none'");
    expect(srcdoc).not.toContain('</style><script>window.parent.hacked=1;');
    expect(srcdoc).toContain('<\\/style>');
    expect(srcdoc).toContain('<\\/script>');
    expect(srcdoc).toContain('nativeQueueMicrotask');
  });

  it('supports native vector zoom and raw early-internet defaults inside sandboxed iframes', () => {
    const srcdoc = buildSandboxSrcDoc({
      objectId: 'obj-zoom',
      revision: 1,
      html: '<blink>RAW</blink>',
      css: '',
      javascript: '',
      zoom: 3.5
    });

    expect(srcdoc).toContain('<html style="zoom: 3.5;">');
    expect(srcdoc).toContain("d.source === 'THE_VOID_HOST' && d.type === 'SET_ZOOM'");
    expect(srcdoc).toContain('image-rendering: pixelated');
    expect(srcdoc).toContain('void-blink');
  });
});
