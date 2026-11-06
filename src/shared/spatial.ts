import {
  CHUNK_SIZE,
  DEFAULT_OBJECT_HEIGHT,
  DEFAULT_OBJECT_WIDTH,
  DEFAULT_ZOOM,
  MAX_OBJECT_HEIGHT,
  MAX_OBJECT_WIDTH,
  MAX_ROTATION,
  MAX_Z_INDEX,
  MAX_ZOOM,
  MIN_OBJECT_HEIGHT,
  MIN_OBJECT_WIDTH,
  MIN_ROTATION,
  MIN_Z_INDEX,
  MIN_ZOOM,
  WORLD_MAX_COORD,
  WORLD_MIN_COORD
} from './constants.js';
import type { BoundingBox, CameraState, VoidObject } from './types.js';

export function isValidFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clampCoord(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(WORLD_MIN_COORD, Math.min(WORLD_MAX_COORD, Math.round(val * 100) / 100));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return DEFAULT_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom * 10000) / 10000));
}

export function clampWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return DEFAULT_OBJECT_WIDTH;
  return Math.max(MIN_OBJECT_WIDTH, Math.min(MAX_OBJECT_WIDTH, Math.round(width)));
}

export function clampHeight(height: number | undefined): number {
  if (height === undefined || !Number.isFinite(height)) return DEFAULT_OBJECT_HEIGHT;
  return Math.max(MIN_OBJECT_HEIGHT, Math.min(MAX_OBJECT_HEIGHT, Math.round(height)));
}

export function clampRotation(rotation: number | undefined): number {
  if (rotation === undefined || !Number.isFinite(rotation)) return 0;
  return Math.max(MIN_ROTATION, Math.min(MAX_ROTATION, Math.round(rotation * 100) / 100));
}

export function clampZIndex(zIndex: number | undefined): number {
  if (zIndex === undefined || !Number.isFinite(zIndex)) return 0;
  return Math.max(MIN_Z_INDEX, Math.min(MAX_Z_INDEX, Math.round(zIndex)));
}

/**
 * Converts screen pixel coordinates (relative to viewport top-left) into world coordinates.
 * Camera (x, y) is the world coordinate at the center of the viewport.
 */
export function screenToWorld(
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
  camera: CameraState
): { x: number; y: number } {
  const safeZoom = clampZoom(camera.zoom);
  const worldX = camera.x + (screenX - viewportWidth / 2) / safeZoom;
  const worldY = camera.y + (screenY - viewportHeight / 2) / safeZoom;
  return {
    x: clampCoord(worldX),
    y: clampCoord(worldY)
  };
}

/**
 * Converts world coordinates into screen pixel coordinates (relative to viewport top-left).
 */
export function worldToScreen(
  worldX: number,
  worldY: number,
  viewportWidth: number,
  viewportHeight: number,
  camera: CameraState
): { x: number; y: number } {
  const safeZoom = clampZoom(camera.zoom);
  const screenX = viewportWidth / 2 + (worldX - camera.x) * safeZoom;
  const screenY = viewportHeight / 2 + (worldY - camera.y) * safeZoom;
  return { x: screenX, y: screenY };
}

/**
 * Computes a new CameraState after zooming to `nextZoom` while keeping the world point
 * currently under `(focalScreenX, focalScreenY)` fixed on screen.
 */
export function zoomAroundScreenPoint(
  camera: CameraState,
  nextZoomRaw: number,
  focalScreenX: number,
  focalScreenY: number,
  viewportWidth: number,
  viewportHeight: number
): CameraState {
  const nextZoom = clampZoom(nextZoomRaw);
  const worldBefore = screenToWorld(focalScreenX, focalScreenY, viewportWidth, viewportHeight, camera);
  const nextCameraX = worldBefore.x - (focalScreenX - viewportWidth / 2) / nextZoom;
  const nextCameraY = worldBefore.y - (focalScreenY - viewportHeight / 2) / nextZoom;
  return {
    x: clampCoord(nextCameraX),
    y: clampCoord(nextCameraY),
    zoom: nextZoom
  };
}

/**
 * Computes the world-space bounding box visible in the current viewport,
 * expanded by `marginRatio` (e.g. 0.35 = 35% extra buffer on each side).
 */
export function getViewportBounds(
  camera: CameraState,
  viewportWidth: number,
  viewportHeight: number,
  marginRatio = 0.35
): BoundingBox {
  const safeZoom = clampZoom(camera.zoom);
  const halfW = (viewportWidth / 2 / safeZoom) * (1 + marginRatio);
  const halfH = (viewportHeight / 2 / safeZoom) * (1 + marginRatio);
  return {
    minX: clampCoord(camera.x - halfW),
    minY: clampCoord(camera.y - halfH),
    maxX: clampCoord(camera.x + halfW),
    maxY: clampCoord(camera.y + halfH)
  };
}

export function getObjectBounds(obj: Pick<VoidObject, 'x' | 'y' | 'width' | 'height'>): BoundingBox {
  return {
    minX: obj.x,
    minY: obj.y,
    maxX: obj.x + obj.width,
    maxY: obj.y + obj.height
  };
}

export function boxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function coordToChunkIndex(coord: number): number {
  return Math.floor(coord / CHUNK_SIZE);
}

export function getChunkKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

export function getChunksForBounds(bounds: BoundingBox, maxChunks = 256): string[] {
  const minCx = coordToChunkIndex(bounds.minX);
  const maxCx = coordToChunkIndex(bounds.maxX);
  const minCy = coordToChunkIndex(bounds.minY);
  const maxCy = coordToChunkIndex(bounds.maxY);

  const keys: string[] = [];
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      keys.push(getChunkKey(cx, cy));
      if (keys.length >= maxChunks) {
        return keys;
      }
    }
  }
  return keys;
}

export function distanceSquaredToCenter(
  obj: Pick<VoidObject, 'x' | 'y' | 'width' | 'height'>,
  centerX: number,
  centerY: number
): number {
  const objCx = obj.x + obj.width / 2;
  const objCy = obj.y + obj.height / 2;
  const dx = objCx - centerX;
  const dy = objCy - centerY;
  return dx * dx + dy * dy;
}

export interface DeepLinkTarget {
  x?: number;
  y?: number;
  zoom?: number;
  objectId?: string;
}

export function parseDeepLinkParams(search: string): DeepLinkTarget {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const result: DeepLinkTarget = {};

  const rawX = params.get('x');
  const rawY = params.get('y');
  const rawZoom = params.get('zoom') ?? params.get('z');
  const rawObject = params.get('object') ?? params.get('id');

  if (rawX !== null && rawX.trim() !== '') {
    const parsedX = Number(rawX);
    if (Number.isFinite(parsedX)) {
      result.x = clampCoord(parsedX);
    }
  }

  if (rawY !== null && rawY.trim() !== '') {
    const parsedY = Number(rawY);
    if (Number.isFinite(parsedY)) {
      result.y = clampCoord(parsedY);
    }
  }

  if (rawZoom !== null && rawZoom.trim() !== '') {
    const parsedZoom = Number(rawZoom);
    if (Number.isFinite(parsedZoom) && parsedZoom > 0) {
      result.zoom = clampZoom(parsedZoom);
    }
  }

  if (rawObject !== null && /^[a-zA-Z0-9_-]{4,64}$/.test(rawObject.trim())) {
    result.objectId = rawObject.trim();
  }

  return result;
}

export function formatDeepLinkSearch(camera: CameraState, selectedObjectId?: string | null): string {
  const params = new URLSearchParams();
  params.set('x', String(Math.round(camera.x)));
  params.set('y', String(Math.round(camera.y)));
  params.set('zoom', String(Math.round(camera.zoom * 100) / 100));
  if (selectedObjectId) {
    params.set('object', selectedObjectId);
  }
  return `?${params.toString()}`;
}

export function formatRelativeTime(isoTimestamp: string, nowMs = Date.now()): string {
  const timeMs = Date.parse(isoTimestamp);
  if (Number.isNaN(timeMs)) return 'unknown time';
  const diffSec = Math.max(0, Math.floor((nowMs - timeMs) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec} seconds ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin === 1) return '1 minute ago';
  if (diffMin < 60) return `${diffMin} minutes ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours === 1) return '1 hour ago';
  if (diffHours < 24) return `${diffHours} hours ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}
