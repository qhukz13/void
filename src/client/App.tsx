import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHUNK_SIZE,
  DEFAULT_OBJECT_HEIGHT,
  DEFAULT_OBJECT_WIDTH,
  DEFAULT_ZOOM,
  MAX_ACTIVE_SANDBOXES,
  SANDBOX_EXECUTION_MIN_ZOOM
} from '../shared/constants.js';
import {
  boxesIntersect,
  clampCoord,
  clampZoom,
  computeInfiniteGridOffset,
  coordToChunkIndex,
  distanceSquaredToCenter,
  formatDeepLinkSearch,
  getObjectBounds,
  getViewportBounds,
  getVisibleSectorMarkers,
  parseDeepLinkParams,
  screenToWorld,
  zoomAroundScreenPoint
} from '../shared/spatial.js';
import type {
  AnonymousCursor,
  CameraState,
  CreateObjectInput,
  SandboxDiagnostic,
  ServerWsMessage,
  UpdateObjectInput,
  VoidObject,
  WorldSignalBeacon
} from '../shared/types.js';
import { InspectorPanel } from './components/InspectorPanel.js';
import { WorldObjectCard } from './components/WorldObjectCard.js';
import { WorldRadar } from './components/WorldRadar.js';
import { type ConnectionState, VoidApiClient } from './services/void-client.js';

function objectToBeacon(obj: VoidObject): WorldSignalBeacon {
  return {
    id: obj.id,
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
    chunkX: coordToChunkIndex(obj.x),
    chunkY: coordToChunkIndex(obj.y),
    revision: obj.revision,
    updatedAt: obj.updatedAt
  };
}

export function App() {
  const initialDeepLink = useMemo(() => parseDeepLinkParams(window.location.search), []);

  const [camera, setCamera] = useState<CameraState>(() => ({
    x: initialDeepLink.x ?? 0,
    y: initialDeepLink.y ?? 0,
    zoom: initialDeepLink.zoom ?? DEFAULT_ZOOM
  }));

  const [coordInputX, setCoordInputX] = useState<string>(() => String(Math.round(initialDeepLink.x ?? 0)));
  const [coordInputY, setCoordInputY] = useState<string>(() => String(Math.round(initialDeepLink.y ?? 0)));

  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>(() => ({
    width: window.innerWidth || 1280,
    height: window.innerHeight || 800
  }));

  const [objectsById, setObjectsById] = useState<Record<string, VoidObject>>({});
  const [signalsById, setSignalsById] = useState<Record<string, WorldSignalBeacon>>({});
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(initialDeepLink.objectId ?? null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [presenceCount, setPresenceCount] = useState<number>(1);
  const [cursors, setCursors] = useState<Record<string, AnonymousCursor>>({});
  const [pointerWorld, setPointerWorld] = useState<{ x: number; y: number }>(() => ({
    x: Math.round(initialDeepLink.x ?? 0),
    y: Math.round(initialDeepLink.y ?? 0)
  }));
  const [diagnosticsByObject, setDiagnosticsByObject] = useState<Record<string, SandboxDiagnostic[]>>({});
  const [revisionBumpToken, setRevisionBumpToken] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [linkCopied, setLinkCopied] = useState<boolean>(false);
  const [framelessMode, setFramelessMode] = useState<boolean>(false);

  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const selectedObjectIdRef = useRef(selectedObjectId);
  selectedObjectIdRef.current = selectedObjectId;

  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;

  const apiClientRef = useRef<VoidApiClient | null>(null);

  const updateCameraPosition = useCallback((nextX: number, nextY: number, nextZoom?: number) => {
    const clampedX = clampCoord(nextX);
    const clampedY = clampCoord(nextY);
    setCamera((prev) => ({
      x: clampedX,
      y: clampedY,
      zoom: nextZoom !== undefined ? clampZoom(nextZoom) : prev.zoom
    }));
    setCoordInputX(String(Math.round(clampedX)));
    setCoordInputY(String(Math.round(clampedY)));
  }, []);

  // Diagnostics handlers
  const handleDiagnostic = useCallback((diag: SandboxDiagnostic) => {
    setDiagnosticsByObject((prev) => {
      const existing = prev[diag.objectId] ?? [];
      if (existing.length >= 25) {
        return {
          ...prev,
          [diag.objectId]: [...existing.slice(1), diag]
        };
      }
      return {
        ...prev,
        [diag.objectId]: [...existing, diag]
      };
    });
  }, []);

  const handleClearDiagnostics = useCallback((objectId: string) => {
    setDiagnosticsByObject((prev) => {
      if (!prev[objectId] || prev[objectId].length === 0) return prev;
      const next = { ...prev };
      delete next[objectId];
      return next;
    });
  }, []);

  // Handle incoming realtime WebSocket messages
  const handleServerMessage = useCallback((msg: ServerWsMessage) => {
    switch (msg.type) {
      case 'WELCOME': {
        setPresenceCount(msg.presenceCount);
        break;
      }

      case 'USER_JOINED':
      case 'USER_LEFT': {
        setPresenceCount(msg.presenceCount);
        if (msg.type === 'USER_LEFT') {
          setCursors((prev) => {
            if (!prev[msg.sessionId]) return prev;
            const next = { ...prev };
            delete next[msg.sessionId];
            return next;
          });
        }
        break;
      }

      case 'CURSOR_MOVED': {
        setCursors((prev) => ({
          ...prev,
          [msg.cursor.sessionId]: msg.cursor
        }));
        break;
      }

      case 'VIEWPORT_SNAPSHOT': {
        setObjectsById((prev) => {
          const next: Record<string, VoidObject> = {};
          const farEvictionBounds = getViewportBounds(
            cameraRef.current,
            viewportSizeRef.current.width,
            viewportSizeRef.current.height,
            2.5
          );
          for (const obj of Object.values(prev)) {
            if (
              !obj.deleted &&
              (obj.id === selectedObjectIdRef.current ||
                boxesIntersect(farEvictionBounds, getObjectBounds(obj)))
            ) {
              next[obj.id] = obj;
            }
          }
          for (const obj of msg.objects) {
            if (!obj.deleted) {
              next[obj.id] = obj;
            }
          }
          return next;
        });
        setSignalsById((prev) => {
          const next = { ...prev };
          for (const obj of msg.objects) {
            if (!obj.deleted) {
              next[obj.id] = objectToBeacon(obj);
            }
          }
          return next;
        });
        break;
      }

      case 'OBJECT_CREATED':
      case 'OBJECT_UPDATED':
      case 'OBJECT_MOVED':
      case 'OBJECT_RESIZED': {
        setObjectsById((prev) => {
          const existing = prev[msg.object.id];
          if (existing && existing.revision > msg.object.revision) {
            return prev;
          }
          return {
            ...prev,
            [msg.object.id]: msg.object
          };
        });
        setSignalsById((prev) => ({
          ...prev,
          [msg.object.id]: objectToBeacon(msg.object)
        }));
        break;
      }

      case 'OBJECT_DELETED': {
        setObjectsById((prev) => {
          if (!prev[msg.objectId]) return prev;
          const next = { ...prev };
          delete next[msg.objectId];
          return next;
        });
        setSignalsById((prev) => {
          if (!prev[msg.objectId]) return prev;
          const next = { ...prev };
          delete next[msg.objectId];
          return next;
        });
        setSelectedObjectId((prevSelected) => (prevSelected === msg.objectId ? null : prevSelected));
        break;
      }

      case 'REVISION_CREATED': {
        setRevisionBumpToken((c) => c + 1);
        break;
      }

      default:
        break;
    }
  }, []);

  // Initialize API & WebSocket client
  useEffect(() => {
    const client = new VoidApiClient(handleServerMessage, setConnectionState);
    apiClientRef.current = client;
    client.connect();

    // Immediate HTTP region fetch + global signal radar fetch
    const initialBounds = getViewportBounds(cameraRef.current, window.innerWidth, window.innerHeight, 0.5);
    void client
      .fetchRegion(initialBounds)
      .then((objs) => {
        setObjectsById((prev) => {
          const next = { ...prev };
          for (const obj of objs) {
            if (!obj.deleted) {
              next[obj.id] = obj;
            }
          }
          return next;
        });
        setSignalsById((prev) => {
          const next = { ...prev };
          for (const obj of objs) {
            if (!obj.deleted) {
              next[obj.id] = objectToBeacon(obj);
            }
          }
          return next;
        });
      })
      .catch(() => {});

    void client
      .fetchWorldSignals()
      .then((data) => {
        setSignalsById((prev) => {
          const next = { ...prev };
          for (const sig of data.signals) {
            next[sig.id] = sig;
          }
          return next;
        });
      })
      .catch(() => {});

    // If deep-linked to a specific object ID, load and focus it
    if (initialDeepLink.objectId) {
      void client
        .fetchObject(initialDeepLink.objectId, false)
        .then((obj) => {
          if (obj && !obj.deleted) {
            setObjectsById((prev) => ({ ...prev, [obj.id]: obj }));
            setSignalsById((prev) => ({ ...prev, [obj.id]: objectToBeacon(obj) }));
            setSelectedObjectId(obj.id);
            if (initialDeepLink.x === undefined && initialDeepLink.y === undefined) {
              const targetX = clampCoord(obj.x + obj.width / 2);
              const targetY = clampCoord(obj.y + obj.height / 2);
              setCamera((prev) => ({ ...prev, x: targetX, y: targetY }));
              setCoordInputX(String(Math.round(targetX)));
              setCoordInputY(String(Math.round(targetY)));
            }
          }
        })
        .catch(() => {});
    }

    return () => {
      client.disconnect();
    };
  }, [handleServerMessage, initialDeepLink]);

  // Subscribe to viewport bounds when camera or viewport size changes
  useEffect(() => {
    const client = apiClientRef.current;
    if (!client) return;

    const bounds = getViewportBounds(camera, viewportSize.width, viewportSize.height, 0.5);
    const timer = window.setTimeout(() => {
      client.subscribeViewport(bounds);
      void client
        .fetchRegion(bounds)
        .then((objs) => {
          setObjectsById((prev) => {
            const farBounds = getViewportBounds(camera, viewportSize.width, viewportSize.height, 2.5);
            const next: Record<string, VoidObject> = {};
            for (const existing of Object.values(prev)) {
              if (
                !existing.deleted &&
                (existing.id === selectedObjectIdRef.current ||
                  boxesIntersect(farBounds, getObjectBounds(existing)))
              ) {
                next[existing.id] = existing;
              }
            }
            for (const obj of objs) {
              if (!obj.deleted) {
                next[obj.id] = obj;
              }
            }
            return next;
          });
          setSignalsById((prev) => {
            const next = { ...prev };
            for (const obj of objs) {
              if (!obj.deleted) {
                next[obj.id] = objectToBeacon(obj);
              }
            }
            return next;
          });
        })
        .catch(() => {});
    }, 90);

    return () => {
      clearTimeout(timer);
    };
  }, [camera, viewportSize.width, viewportSize.height]);

  // Watch selected object via WS
  useEffect(() => {
    apiClientRef.current?.watchObject(selectedObjectId);
  }, [selectedObjectId]);

  // Sync URL query parameters (deep links) with camera & selection
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = formatDeepLinkSearch(camera, selectedObjectId);
      if (window.location.search !== search) {
        window.history.replaceState(null, '', `${window.location.pathname}${search}`);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [camera, selectedObjectId]);

  // Listen to browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const target = parseDeepLinkParams(window.location.search);
      setCamera((prev) => ({
        x: target.x ?? prev.x,
        y: target.y ?? prev.y,
        zoom: target.zoom ?? prev.zoom
      }));
      if (target.x !== undefined) setCoordInputX(String(Math.round(target.x)));
      if (target.y !== undefined) setCoordInputY(String(Math.round(target.y)));
      if (target.objectId !== undefined) setSelectedObjectId(target.objectId);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Track window resize, periodic timestamp refresh, & signal radar refresh
  useEffect(() => {
    const onResize = () => {
      setViewportSize({
        width: window.innerWidth || 1280,
        height: window.innerHeight || 800
      });
    };
    window.addEventListener('resize', onResize);

    const tick = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      setCursors((prev) => {
        let changed = false;
        const next: Record<string, AnonymousCursor> = {};
        for (const [sid, cur] of Object.entries(prev)) {
          if (now - cur.updatedAt < 8000) {
            next[sid] = cur;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      void apiClientRef.current
        ?.fetchWorldSignals()
        .then((data) => {
          setSignalsById(() => {
            const next: Record<string, WorldSignalBeacon> = {};
            for (const sig of data.signals) {
              next[sig.id] = sig;
            }
            return next;
          });
        })
        .catch(() => {});
    }, 5000);

    return () => {
      window.removeEventListener('resize', onResize);
      clearInterval(tick);
    };
  }, []);

  // Continuous 60fps Open-World Keyboard Roaming (WASD / Arrow Keys + Shift Boost) & Escape handler
  const pressedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
        return true;
      }
      if (el.closest('.void-inspector') || el.closest('.monaco-editor')) {
        return true;
      }
      return false;
    };

    const navKeys = new Set([
      'w',
      'a',
      's',
      'd',
      'arrowup',
      'arrowdown',
      'arrowleft',
      'arrowright',
      'shift'
    ]);

    let rafId: number | null = null;
    let lastFrameTime = performance.now();

    const stepFlight = (now: number) => {
      const dtSec = Math.min(0.1, Math.max(0.001, (now - lastFrameTime) / 1000));
      lastFrameTime = now;

      const keys = pressedKeysRef.current;
      let vx = 0;
      let vy = 0;
      if (keys.has('w') || keys.has('arrowup')) vy -= 1;
      if (keys.has('s') || keys.has('arrowdown')) vy += 1;
      if (keys.has('a') || keys.has('arrowleft')) vx -= 1;
      if (keys.has('d') || keys.has('arrowright')) vx += 1;

      if (vx !== 0 || vy !== 0) {
        const len = Math.hypot(vx, vy);
        const boost = keys.has('shift') ? 3.8 : 1.0;
        const speedPxPerSec = 680 * boost;
        const currentCam = cameraRef.current;
        const worldStep = (speedPxPerSec * dtSec) / currentCam.zoom;
        const nextX = clampCoord(currentCam.x + (vx / len) * worldStep);
        const nextY = clampCoord(currentCam.y + (vy / len) * worldStep);
        setCamera((prev) => ({
          ...prev,
          x: nextX,
          y: nextY
        }));
        setCoordInputX(String(Math.round(nextX)));
        setCoordInputY(String(Math.round(nextY)));
        rafId = requestAnimationFrame(stepFlight);
      } else {
        rafId = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedObjectIdRef.current) {
        setSelectedObjectId(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) {
        return;
      }
      const key = e.key.toLowerCase();
      if (navKeys.has(key)) {
        pressedKeysRef.current.add(key);
        if (rafId === null) {
          lastFrameTime = performance.now();
          rafId = requestAnimationFrame(stepFlight);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      pressedKeysRef.current.delete(key);
    };

    const onBlur = () => {
      pressedKeysRef.current.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // CRUD actions
  const handleCreateObjectAt = useCallback(async (worldX: number, worldY: number, overrides?: Partial<CreateObjectInput>) => {
    const client = apiClientRef.current;
    if (!client) return null;

    const payload: CreateObjectInput = {
      x: clampCoord(Math.round(worldX)),
      y: clampCoord(Math.round(worldY)),
      width: DEFAULT_OBJECT_WIDTH,
      height: DEFAULT_OBJECT_HEIGHT,
      ...overrides
    };

    const { object } = await client.createObject(payload);
    setObjectsById((prev) => ({
      ...prev,
      [object.id]: object
    }));
    setSignalsById((prev) => ({
      ...prev,
      [object.id]: objectToBeacon(object)
    }));
    setSelectedObjectId(object.id);
    return object;
  }, []);

  const handleSaveObject = useCallback(async (objectId: string, patch: UpdateObjectInput): Promise<VoidObject> => {
    const client = apiClientRef.current;
    if (!client) throw new Error('Client not initialized');
    const { object } = await client.updateObject(objectId, patch);
    setObjectsById((prev) => ({
      ...prev,
      [object.id]: object
    }));
    setSignalsById((prev) => ({
      ...prev,
      [object.id]: objectToBeacon(object)
    }));
    return object;
  }, []);

  const handleOptimisticMove = useCallback(
    (objectId: string, x: number, y: number, commit: boolean) => {
      setObjectsById((prev) => {
        const existing = prev[objectId];
        if (!existing) return prev;
        return {
          ...prev,
          [objectId]: {
            ...existing,
            x,
            y
          }
        };
      });
      setSignalsById((prev) => {
        const existing = prev[objectId];
        if (!existing) return prev;
        return {
          ...prev,
          [objectId]: {
            ...existing,
            x,
            y,
            chunkX: coordToChunkIndex(x),
            chunkY: coordToChunkIndex(y)
          }
        };
      });
      if (commit) {
        void handleSaveObject(objectId, { x, y }).catch(() => {});
      }
    },
    [handleSaveObject]
  );

  const handleOptimisticResize = useCallback(
    (objectId: string, width: number, height: number, commit: boolean) => {
      setObjectsById((prev) => {
        const existing = prev[objectId];
        if (!existing) return prev;
        return {
          ...prev,
          [objectId]: {
            ...existing,
            width,
            height
          }
        };
      });
      setSignalsById((prev) => {
        const existing = prev[objectId];
        if (!existing) return prev;
        return {
          ...prev,
          [objectId]: {
            ...existing,
            width,
            height
          }
        };
      });
      if (commit) {
        void handleSaveObject(objectId, { width, height }).catch(() => {});
      }
    },
    [handleSaveObject]
  );

  const handleCopyObject = useCallback(
    async (sourceObj: VoidObject) => {
      await handleCreateObjectAt(sourceObj.x + 48, sourceObj.y + 48, {
        width: sourceObj.width,
        height: sourceObj.height,
        html: sourceObj.html,
        css: sourceObj.css,
        javascript: sourceObj.javascript
      });
    },
    [handleCreateObjectAt]
  );

  const handleDeleteObject = useCallback(async (objectId: string) => {
    const client = apiClientRef.current;
    if (!client) return;
    // Optimistically remove from active view
    setObjectsById((prev) => {
      if (!prev[objectId]) return prev;
      const next = { ...prev };
      delete next[objectId];
      return next;
    });
    setSignalsById((prev) => {
      if (!prev[objectId]) return prev;
      const next = { ...prev };
      delete next[objectId];
      return next;
    });
    setSelectedObjectId((prev) => (prev === objectId ? null : prev));
    try {
      await client.deleteObject(objectId);
    } catch (_) {}
  }, []);

  // Warp camera to any coordinate or signal in the infinite world
  const handleWarpTo = useCallback(
    (targetX: number, targetY: number, targetObjectId?: string) => {
      updateCameraPosition(targetX, targetY);
      if (targetObjectId) {
        setSelectedObjectId(targetObjectId);
        void apiClientRef.current
          ?.fetchObject(targetObjectId, false)
          .then((obj) => {
            if (obj && !obj.deleted) {
              setObjectsById((prev) => ({ ...prev, [obj.id]: obj }));
              setSignalsById((prev) => ({ ...prev, [obj.id]: objectToBeacon(obj) }));
            }
          })
          .catch(() => {});
      }
    },
    [updateCameraPosition]
  );

  // Jump to an unexplored frontier sector in the infinite world
  const handleWarpUncharted = useCallback(() => {
    const occupiedSectors = new Set(
      Object.values(signalsById).map((s) => `${s.chunkX}:${s.chunkY}`)
    );
    const curCx = coordToChunkIndex(cameraRef.current.x);
    const curCy = coordToChunkIndex(cameraRef.current.y);

    // Pick a golden-angle spiral sector step outward until an unoccupied sector is found
    let radius = Math.max(2, Math.floor(Math.random() * 12) + 2);
    let angle = Math.random() * Math.PI * 2;
    let targetCx = curCx + Math.round(Math.cos(angle) * radius);
    let targetCy = curCy + Math.round(Math.sin(angle) * radius);

    while (occupiedSectors.has(`${targetCx}:${targetCy}`) && radius < 10_000) {
      radius += 3;
      angle += 2.399963229728653;
      targetCx = curCx + Math.round(Math.cos(angle) * radius);
      targetCy = curCy + Math.round(Math.sin(angle) * radius);
    }

    const worldX = targetCx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const worldY = targetCy * CHUNK_SIZE + CHUNK_SIZE / 2;
    updateCameraPosition(worldX, worldY, 1);
  }, [signalsById, updateCameraPosition]);

  // Canvas panning & pinch-zoom state
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const panOriginRef = useRef<{
    screenX: number;
    screenY: number;
    camX: number;
    camY: number;
    moved: boolean;
  } | null>(null);
  const pinchDistRef = useRef<number | null>(null);
  const lastCursorSentRef = useRef<number>(0);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('void-world-plane')) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 1) {
      panOriginRef.current = {
        screenX: e.clientX,
        screenY: e.clientY,
        camX: camera.x,
        camY: camera.y,
        moved: false
      };
      setIsPanning(true);
    } else if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      pinchDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (now - lastCursorSentRef.current > 80) {
      lastCursorSentRef.current = now;
      const worldPos = screenToWorld(
        e.clientX,
        e.clientY,
        viewportSize.width,
        viewportSize.height,
        camera
      );
      setPointerWorld({
        x: Math.round(worldPos.x),
        y: Math.round(worldPos.y)
      });
      apiClientRef.current?.sendCursorMove(worldPos.x, worldPos.y);
    }

    if (!activePointersRef.current.has(e.pointerId)) return;
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchDistRef.current && pinchDistRef.current > 10) {
        const ratio = dist / pinchDistRef.current;
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        const nextCam = zoomAroundScreenPoint(
          camera,
          camera.zoom * ratio,
          midX,
          midY,
          viewportSize.width,
          viewportSize.height
        );
        updateCameraPosition(nextCam.x, nextCam.y, nextCam.zoom);
      }
      pinchDistRef.current = dist;
      return;
    }

    const pan = panOriginRef.current;
    if (!pan) return;
    const dx = e.clientX - pan.screenX;
    const dy = e.clientY - pan.screenY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      pan.moved = true;
    }
    if (pan.moved) {
      const nextX = pan.camX - dx / camera.zoom;
      const nextY = pan.camY - dy / camera.zoom;
      updateCameraPosition(nextX, nextY);
    }
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (activePointersRef.current.size < 2) {
      pinchDistRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      setIsPanning(false);
      panOriginRef.current = null;
    }
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.void-object-card')) {
      return;
    }
    const worldPt = screenToWorld(
      e.clientX,
      e.clientY,
      viewportSize.width,
      viewportSize.height,
      camera
    );
    void handleCreateObjectAt(
      worldPt.x - DEFAULT_OBJECT_WIDTH / 2,
      worldPt.y - DEFAULT_OBJECT_HEIGHT / 2
    );
  };

  const handleCanvasWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (
      (e.target as HTMLElement).closest('.void-inspector') ||
      (e.target as HTMLElement).closest('.void-radar-dock')
    ) {
      return;
    }
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextCam = zoomAroundScreenPoint(
      camera,
      camera.zoom * zoomFactor,
      e.clientX,
      e.clientY,
      viewportSize.width,
      viewportSize.height
    );
    updateCameraPosition(nextCam.x, nextCam.y, nextCam.zoom);
  };

  // Compute visible objects, procedural sector markers, and active sandboxes
  const visibleBounds = useMemo(
    () => getViewportBounds(camera, viewportSize.width, viewportSize.height, 0.35),
    [camera, viewportSize.width, viewportSize.height]
  );

  const visibleObjects = useMemo(() => {
    const all = Object.values(objectsById);
    return all.filter(
      (obj) => !obj.deleted && boxesIntersect(visibleBounds, getObjectBounds(obj))
    );
  }, [objectsById, visibleBounds]);

  const visibleSectorMarkers = useMemo(
    () => getVisibleSectorMarkers(visibleBounds, camera.zoom),
    [visibleBounds, camera.zoom]
  );

  const activeSandboxIds = useMemo(() => {
    if (camera.zoom < SANDBOX_EXECUTION_MIN_ZOOM) {
      return new Set<string>(selectedObjectId ? [selectedObjectId] : []);
    }
    const sorted = [...visibleObjects].sort((a, b) => {
      if (a.id === selectedObjectId) return -1;
      if (b.id === selectedObjectId) return 1;
      return (
        distanceSquaredToCenter(a, camera.x, camera.y) -
        distanceSquaredToCenter(b, camera.x, camera.y)
      );
    });
    return new Set(sorted.slice(0, MAX_ACTIVE_SANDBOXES).map((o) => o.id));
  }, [visibleObjects, camera.x, camera.y, camera.zoom, selectedObjectId]);

  const allSignals = useMemo(() => Object.values(signalsById), [signalsById]);
  const activeSectorCount = useMemo(() => {
    const set = new Set<string>();
    for (const s of allSignals) {
      set.add(`${s.chunkX}:${s.chunkY}`);
    }
    return set.size;
  }, [allSignals]);

  const selectedObject = selectedObjectId ? objectsById[selectedObjectId] ?? null : null;

  const handleCoordinateJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedX = Number(coordInputX);
    const parsedY = Number(coordInputY);
    if (Number.isFinite(parsedX) && Number.isFinite(parsedY)) {
      updateCameraPosition(parsedX, parsedY);
    }
  };

  const handleCopyDeepLink = async () => {
    const url = window.location.href;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      }
    } catch (_) {}
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1800);
  };

  // Floating-origin grid offsets (modular in world space first so precision never degrades at ±10^12)
  const minorGridX = computeInfiniteGridOffset(viewportSize.width, camera.x, camera.zoom, 128);
  const minorGridY = computeInfiniteGridOffset(viewportSize.height, camera.y, camera.zoom, 128);
  const majorGridX = computeInfiniteGridOffset(viewportSize.width, camera.x, camera.zoom, 512);
  const majorGridY = computeInfiniteGridOffset(viewportSize.height, camera.y, camera.zoom, 512);

  const showOriginMonument =
    Math.abs(camera.x) < 25_000 && Math.abs(camera.y) < 25_000;

  return (
    <main className="void-shell" data-testid="void-world-shell">
      {/* Top-left HUD Instrument Bar */}
      <header className="void-hud-top" aria-label="World Navigation Instrument">
        <div className="void-hud-module">
          <span className="void-brand">
            <span className="void-brand-mark" aria-hidden="true" />
            THE VOID
          </span>
          <span className="void-status-group">
            <span
              className={`void-status-dot ${
                connectionState === 'online'
                  ? ''
                  : connectionState === 'reconnecting' || connectionState === 'connecting'
                    ? 'reconnecting'
                    : 'offline'
              }`}
              title={`Connection: ${connectionState}`}
            />
            <span data-testid="hud-connection-status" className="void-hud-status-text">
              {connectionState}
            </span>
          </span>
          <span className="void-hud-divider" aria-hidden="true" />
          <span data-testid="hud-presence-count" className="void-telemetry-metric">
            {presenceCount} {presenceCount === 1 ? 'visitor' : 'visitors'}
          </span>
          <span className="void-hud-divider" aria-hidden="true" />
          <span data-testid="hud-object-count" className="void-telemetry-metric">
            {visibleObjects.length} in view
          </span>
        </div>

        <form className="void-hud-module void-coord-form" onSubmit={handleCoordinateJumpSubmit}>
          <label className="void-coord-label">
            <span className="void-coord-axis">X</span>
            <input
              type="number"
              className="void-coord-input"
              data-testid="coord-input-x"
              aria-label="World X Coordinate"
              value={coordInputX}
              onChange={(e) => setCoordInputX(e.target.value)}
            />
          </label>
          <label className="void-coord-label">
            <span className="void-coord-axis">Y</span>
            <input
              type="number"
              className="void-coord-input"
              data-testid="coord-input-y"
              aria-label="World Y Coordinate"
              value={coordInputY}
              onChange={(e) => setCoordInputY(e.target.value)}
            />
          </label>
          <button type="submit" className="void-btn" data-testid="coord-jump-btn">
            go
          </button>
          <button
            type="button"
            className="void-btn"
            data-testid="origin-jump-btn"
            title="Return to origin (0, 0)"
            onClick={() => updateCameraPosition(0, 0, 1)}
          >
            0,0
          </button>
        </form>

        <div className="void-hud-module">
          <div className="void-zoom-cluster">
            <button
              type="button"
              className="void-btn"
              data-testid="zoom-out-btn"
              aria-label="Zoom out"
              onClick={() => updateCameraPosition(camera.x, camera.y, camera.zoom / 1.25)}
            >
              -
            </button>
            <button
              type="button"
              className="void-btn"
              data-testid="zoom-reset-btn"
              title="Reset zoom to 1.0x"
              onClick={() => updateCameraPosition(camera.x, camera.y, 1)}
            >
              {camera.zoom.toFixed(2)}x
            </button>
            <button
              type="button"
              className="void-btn"
              data-testid="zoom-in-btn"
              aria-label="Zoom in"
              onClick={() => updateCameraPosition(camera.x, camera.y, camera.zoom * 1.25)}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="void-btn"
            data-testid="toggle-frameless-btn"
            title="Toggle between seamless open-world matter and framed cards"
            onClick={() => setFramelessMode((prev) => !prev)}
          >
            {framelessMode ? 'open world' : 'framed'}
          </button>
          <button
            type="button"
            className="void-btn"
            data-testid="copy-deeplink-btn"
            onClick={() => void handleCopyDeepLink()}
          >
            {linkCopied ? 'linked' : 'link'}
          </button>
          <button
            type="button"
            className="void-btn primary"
            data-testid="hud-create-btn"
            onClick={() =>
              void handleCreateObjectAt(
                camera.x - DEFAULT_OBJECT_WIDTH / 2,
                camera.y - DEFAULT_OBJECT_HEIGHT / 2
              )
            }
          >
            + create object
          </button>
        </div>
      </header>

      {/* Infinite Spatial World Canvas (Floating-Origin Coordinate Plane) */}
      <div
        className={`void-canvas ${isPanning ? 'is-panning' : ''}`}
        data-testid="void-canvas"
        tabIndex={0}
        aria-label="Infinite Programmable World Space"
        style={{
          backgroundImage: `
            linear-gradient(to right, var(--void-grid-major) 1px, transparent 1px),
            linear-gradient(to bottom, var(--void-grid-major) 1px, transparent 1px),
            linear-gradient(to right, var(--void-grid-minor) 1px, transparent 1px),
            linear-gradient(to bottom, var(--void-grid-minor) 1px, transparent 1px)
          `,
          backgroundSize: `
            ${majorGridX.gridSizePx}px ${majorGridY.gridSizePx}px,
            ${majorGridX.gridSizePx}px ${majorGridY.gridSizePx}px,
            ${minorGridX.gridSizePx}px ${minorGridY.gridSizePx}px,
            ${minorGridX.gridSizePx}px ${minorGridY.gridSizePx}px
          `,
          backgroundPosition: `
            ${majorGridX.offsetPx}px ${majorGridY.offsetPx}px,
            ${majorGridX.offsetPx}px ${majorGridY.offsetPx}px,
            ${minorGridX.offsetPx}px ${minorGridY.offsetPx}px,
            ${minorGridX.offsetPx}px ${minorGridY.offsetPx}px
          `
        }}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
        onDoubleClick={handleCanvasDoubleClick}
        onWheel={handleCanvasWheel}
      >
        <div
          className="void-world-plane"
          data-testid="void-world-plane"
        >
          {/* Procedural Infinite Sector Lattice Markers */}
          {visibleSectorMarkers.map((sec) => {
            const sx = Math.round(viewportSize.width / 2 + (sec.worldX - camera.x) * camera.zoom);
            const sy = Math.round(viewportSize.height / 2 + (sec.worldY - camera.y) * camera.zoom);
            return (
              <div
                key={sec.key}
                className="void-sector-marker"
                style={{
                  left: `${sx}px`,
                  top: `${sy}px`
                }}
              >
                <span className="void-sector-cross" />
                <span className="void-sector-tag">
                  SEC [{sec.cx}:{sec.cy}] · ({sec.worldX}, {sec.worldY})
                </span>
              </div>
            );
          })}

          {/* Origin Reticle Monument at (0, 0) */}
          {showOriginMonument && (
            <div
              className="void-origin-marker"
              title="Origin (0, 0)"
              style={{
                left: `${Math.round(viewportSize.width / 2 + (0 - camera.x) * camera.zoom - 40)}px`,
                top: `${Math.round(viewportSize.height / 2 + (0 - camera.y) * camera.zoom - 40)}px`
              }}
            >
              <div className="void-origin-core" />
              <span className="void-origin-label">0, 0</span>
            </div>
          )}

          {/* Active World Objects */}
          {visibleObjects.map((obj) => (
            <WorldObjectCard
              key={obj.id}
              object={obj}
              selected={obj.id === selectedObjectId}
              sandboxActive={activeSandboxIds.has(obj.id)}
              cameraX={camera.x}
              cameraY={camera.y}
              cameraZoom={camera.zoom}
              viewportWidth={viewportSize.width}
              viewportHeight={viewportSize.height}
              frameless={framelessMode}
              diagnostics={diagnosticsByObject[obj.id] ?? []}
              nowMs={nowMs}
              onSelect={setSelectedObjectId}
              onOptimisticMove={handleOptimisticMove}
              onOptimisticResize={handleOptimisticResize}
              onCopyObject={(source) => void handleCopyObject(source)}
              onDeleteObject={(id) => void handleDeleteObject(id)}
              onDiagnostic={handleDiagnostic}
              onClearDiagnostics={handleClearDiagnostics}
            />
          ))}

          {/* Anonymous visitor cursors */}
          {Object.values(cursors).map((cur) => {
            const cx = Math.round(viewportSize.width / 2 + (cur.x - camera.x) * camera.zoom);
            const cy = Math.round(viewportSize.height / 2 + (cur.y - camera.y) * camera.zoom);
            return (
              <div
                key={cur.sessionId}
                className="void-anon-cursor"
                style={{
                  left: `${cx}px`,
                  top: `${cy}px`
                }}
              >
                <span className="void-anon-cursor-tag">
                  {Math.round(cur.x)}, {Math.round(cur.y)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Empty sector indicator when no objects are in the current viewport */}
      {visibleObjects.length === 0 && (
        <div className="void-empty-sector-banner">
          <span className="void-empty-sector-tag">UNCHARTED SECTOR</span>
          <span>
            [{coordToChunkIndex(camera.x)}:{coordToChunkIndex(camera.y)}] @ ({Math.round(camera.x)}, {Math.round(camera.y)}) — double-click canvas to materialize
          </span>
        </div>
      )}

      {/* Bottom-left contextual hint & live cursor telemetry bar */}
      <footer className="void-hud-bottom" data-testid="void-hints">
        <span className="void-cursor-telemetry">
          POS {pointerWorld.x}, {pointerWorld.y}
        </span>
        <span className="void-hint-item">
          <kbd className="void-kbd">WASD</kbd> roam
        </span>
        <span>·</span>
        <span className="void-hint-item">
          <kbd className="void-kbd">dbl-click</kbd> create
        </span>
        <span>·</span>
        <span className="void-hint-item">
          <kbd className="void-kbd">click</kbd> inspect
        </span>
        <span>·</span>
        <span className="void-hint-item">
          <kbd className="void-kbd">drag bar</kbd> move
        </span>
      </footer>

      {/* Spatial Radar Minimap & Signal Scanner */}
      <WorldRadar
        camera={camera}
        viewportWidth={viewportSize.width}
        viewportHeight={viewportSize.height}
        signals={allSignals}
        totalActiveObjects={allSignals.length}
        activeSectors={activeSectorCount}
        cursors={cursors}
        selectedObjectId={selectedObjectId}
        inspectorOpen={Boolean(selectedObject)}
        nowMs={nowMs}
        onWarpTo={handleWarpTo}
        onWarpUncharted={handleWarpUncharted}
      />

      {/* Inspector & Code Editor Dock */}
      {selectedObject && apiClientRef.current && (
        <InspectorPanel
          object={selectedObject}
          apiClient={apiClientRef.current}
          diagnostics={diagnosticsByObject[selectedObject.id] ?? []}
          nowMs={nowMs}
          revisionBumpToken={revisionBumpToken}
          onClose={() => setSelectedObjectId(null)}
          onSaveObject={handleSaveObject}
          onCopyIntoNewObject={async (input) => {
            const created = await handleCreateObjectAt(input.x, input.y, input);
            if (!created) throw new Error('Failed to create object');
            return created;
          }}
          onDeleteObject={handleDeleteObject}
          onClearDiagnostics={handleClearDiagnostics}
        />
      )}
    </main>
  );
}
