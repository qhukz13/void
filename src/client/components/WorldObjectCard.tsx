import React, { useRef } from 'react';
import {
  MAX_OBJECT_HEIGHT,
  MAX_OBJECT_WIDTH,
  MIN_OBJECT_HEIGHT,
  MIN_OBJECT_WIDTH
} from '../../shared/constants.js';
import { clampCoord, formatRelativeTime } from '../../shared/spatial.js';
import type { SandboxDiagnostic, VoidObject } from '../../shared/types.js';
import { SandboxFrame } from './SandboxFrame.js';

interface WorldObjectCardProps {
  object: VoidObject;
  selected: boolean;
  sandboxActive: boolean;
  cameraX: number;
  cameraY: number;
  cameraZoom: number;
  viewportWidth: number;
  viewportHeight: number;
  frameless: boolean;
  diagnostics: SandboxDiagnostic[];
  nowMs: number;
  onSelect: (objectId: string) => void;
  onOptimisticMove: (objectId: string, x: number, y: number, commit: boolean) => void;
  onOptimisticResize: (objectId: string, width: number, height: number, commit: boolean) => void;
  onCopyObject: (object: VoidObject) => void;
  onDeleteObject: (objectId: string) => void;
  onDiagnostic: (diag: SandboxDiagnostic) => void;
  onClearDiagnostics: (objectId: string) => void;
}

export function WorldObjectCard({
  object,
  selected,
  sandboxActive,
  cameraX,
  cameraY,
  cameraZoom,
  viewportWidth,
  viewportHeight,
  frameless,
  diagnostics,
  nowMs,
  onSelect,
  onOptimisticMove,
  onOptimisticResize,
  onCopyObject,
  onDeleteObject,
  onDiagnostic,
  onClearDiagnostics
}: WorldObjectCardProps) {
  const dragStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const resizeStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    origW: number;
    origH: number;
    resized: boolean;
  } | null>(null);

  const faultDiagnostics = diagnostics.filter(
    (d) =>
      d.type === 'syntax_error' ||
      d.type === 'runtime_error' ||
      d.type === 'timeout_error' ||
      d.type === 'dom_limit' ||
      d.type === 'resource_limit'
  );
  const latestFault = faultDiagnostics[faultDiagnostics.length - 1] ?? null;

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }
    e.stopPropagation();
    onSelect(object.id);

    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      origX: object.x,
      origY: object.y,
      moved: false
    };
  };

  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current;
    if (!st) return;
    e.stopPropagation();
    const dx = (e.clientX - st.startScreenX) / cameraZoom;
    const dy = (e.clientY - st.startScreenY) / cameraZoom;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      st.moved = true;
      const nextX = clampCoord(Math.round(st.origX + dx));
      const nextY = clampCoord(Math.round(st.origY + dy));
      onOptimisticMove(object.id, nextX, nextY, false);
    }
  };

  const handleHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current;
    if (!st) return;
    e.stopPropagation();
    dragStateRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (st.moved) {
      const dx = (e.clientX - st.startScreenX) / cameraZoom;
      const dy = (e.clientY - st.startScreenY) / cameraZoom;
      const nextX = clampCoord(Math.round(st.origX + dx));
      const nextY = clampCoord(Math.round(st.origY + dy));
      onOptimisticMove(object.id, nextX, nextY, true);
    }
  };

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    onSelect(object.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeStateRef.current = {
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      origW: object.width,
      origH: object.height,
      resized: false
    };
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = resizeStateRef.current;
    if (!st) return;
    e.stopPropagation();
    const dw = (e.clientX - st.startScreenX) / cameraZoom;
    const dh = (e.clientY - st.startScreenY) / cameraZoom;
    if (Math.abs(dw) > 1 || Math.abs(dh) > 1) {
      st.resized = true;
      const nextW = Math.max(MIN_OBJECT_WIDTH, Math.min(MAX_OBJECT_WIDTH, Math.round(st.origW + dw)));
      const nextH = Math.max(MIN_OBJECT_HEIGHT, Math.min(MAX_OBJECT_HEIGHT, Math.round(st.origH + dh)));
      onOptimisticResize(object.id, nextW, nextH, false);
    }
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = resizeStateRef.current;
    if (!st) return;
    e.stopPropagation();
    resizeStateRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (st.resized) {
      const dw = (e.clientX - st.startScreenX) / cameraZoom;
      const dh = (e.clientY - st.startScreenY) / cameraZoom;
      const nextW = Math.max(MIN_OBJECT_WIDTH, Math.min(MAX_OBJECT_WIDTH, Math.round(st.origW + dw)));
      const nextH = Math.max(MIN_OBJECT_HEIGHT, Math.min(MAX_OBJECT_HEIGHT, Math.round(st.origH + dh)));
      onOptimisticResize(object.id, nextW, nextH, true);
    }
  };

  const timeLabel =
    object.revision > 1
      ? `modified ${formatRelativeTime(object.updatedAt, nowMs)}`
      : `created ${formatRelativeTime(object.createdAt, nowMs)}`;

  // Position and size directly in integer-snapped screen pixels (no CSS scale() bitmap blur)
  const screenX = Math.round(viewportWidth / 2 + (object.x - cameraX) * cameraZoom);
  const screenY = Math.round(viewportHeight / 2 + (object.y - cameraY) * cameraZoom);
  const screenW = Math.max(64, Math.round(object.width * cameraZoom));
  const screenH = Math.max(48, Math.round(object.height * cameraZoom));

  return (
    <div
      className={`void-object-card ${frameless ? 'is-frameless' : ''} ${selected ? 'is-selected' : ''} ${latestFault ? 'has-fault' : ''}`}
      style={{
        left: `${screenX}px`,
        top: `${screenY}px`,
        width: `${screenW}px`,
        height: `${screenH}px`,
        zIndex: selected ? 100000 : object.zIndex,
        transform: object.rotation ? `rotate(${object.rotation}deg)` : undefined
      }}
      data-testid={`world-object-${object.id}`}
      data-object-id={object.id}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(object.id);
      }}
    >
      <div
        className="void-object-header"
        data-testid={`object-header-${object.id}`}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerUp}
      >
        <div className="void-object-meta">
          <span
            className={`void-object-led ${latestFault ? 'fault' : sandboxActive ? '' : 'dormant'}`}
            title={latestFault ? 'Sandbox fault' : sandboxActive ? 'Active sandbox' : 'Dormant sandbox'}
          />
          <span className="void-object-id">#{object.id.slice(0, 6)}</span>
          <span className="void-object-rev">r{object.revision}</span>
          <span className="void-object-time">{timeLabel}</span>
          {latestFault && (
            <span className="void-object-fault-badge" data-testid={`object-fault-badge-${object.id}`}>
              FAULT
            </span>
          )}
        </div>
        <div className="void-object-actions">
          <button
            type="button"
            className="void-mini-btn"
            title="Inspect & edit source"
            data-testid={`inspect-btn-${object.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(object.id);
            }}
          >
            code
          </button>
          <button
            type="button"
            className="void-mini-btn"
            title="Copy source into a new independent object"
            data-testid={`copy-btn-${object.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onCopyObject(object);
            }}
          >
            copy
          </button>
          <button
            type="button"
            className="void-mini-btn danger"
            title="Delete object from the world"
            data-testid={`delete-btn-${object.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onDeleteObject(object.id);
            }}
          >
            del
          </button>
        </div>
      </div>

      <div className="void-object-body">
        <SandboxFrame
          object={object}
          active={sandboxActive}
          cameraZoom={cameraZoom}
          onDiagnostic={onDiagnostic}
          onClearDiagnostics={onClearDiagnostics}
        />
        {latestFault && (
          <div className="void-fault-banner" data-testid={`object-fault-banner-${object.id}`}>
            {latestFault.message}
          </div>
        )}
      </div>

      <div
        className="void-resize-handle"
        title="Drag to resize"
        data-testid={`resize-handle-${object.id}`}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
      />
    </div>
  );
}
