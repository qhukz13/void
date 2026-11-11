import React, { useState } from 'react';
import { CHUNK_SIZE } from '../../shared/constants.js';
import { coordToChunkIndex, formatRelativeTime } from '../../shared/spatial.js';
import type { AnonymousCursor, CameraState, WorldSignalBeacon } from '../../shared/types.js';

interface WorldRadarProps {
  camera: CameraState;
  viewportWidth: number;
  viewportHeight: number;
  signals: WorldSignalBeacon[];
  totalActiveObjects: number;
  activeSectors: number;
  cursors: Record<string, AnonymousCursor>;
  selectedObjectId: string | null;
  inspectorOpen: boolean;
  nowMs: number;
  onWarpTo: (x: number, y: number, selectObjectId?: string) => void;
  onWarpUncharted: () => void;
}

const RADAR_SIZE = 148;
const RADAR_HALF = RADAR_SIZE / 2;

export function WorldRadar({
  camera,
  viewportWidth,
  viewportHeight,
  signals,
  totalActiveObjects,
  activeSectors,
  cursors,
  selectedObjectId,
  inspectorOpen,
  nowMs,
  onWarpTo,
  onWarpUncharted
}: WorldRadarProps) {
  const [scannerOpen, setScannerOpen] = useState(false);

  const currentChunkX = coordToChunkIndex(camera.x);
  const currentChunkY = coordToChunkIndex(camera.y);

  // Radar world radius scales dynamically with camera zoom (minimum 3072 world units radius)
  const radarWorldRadius = Math.max(3072, Math.round(2800 / camera.zoom));
  const scale = RADAR_HALF / radarWorldRadius;

  const vpW = Math.max(6, Math.min(RADAR_SIZE - 4, (viewportWidth / camera.zoom) * scale));
  const vpH = Math.max(6, Math.min(RADAR_SIZE - 4, (viewportHeight / camera.zoom) * scale));

  const originDx = (0 - camera.x) * scale;
  const originDy = (0 - camera.y) * scale;
  const originInScope =
    Math.abs(originDx) <= RADAR_HALF - 4 && Math.abs(originDy) <= RADAR_HALF - 4;

  const handleRadarClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left - RADAR_HALF;
    const clickY = e.clientY - rect.top - RADAR_HALF;
    const targetWorldX = camera.x + clickX / scale;
    const targetWorldY = camera.y + clickY / scale;
    onWarpTo(Math.round(targetWorldX), Math.round(targetWorldY));
  };

  const sortedSignals = [...signals]
    .map((sig) => {
      const cx = sig.x + sig.width / 2;
      const cy = sig.y + sig.height / 2;
      const dist = Math.round(Math.hypot(cx - camera.x, cy - camera.y));
      return { sig, cx, cy, dist };
    })
    .sort((a, b) => a.dist - b.dist);

  return (
    <aside
      className={`void-radar-dock ${inspectorOpen ? 'with-inspector' : ''}`}
      data-testid="world-radar"
      aria-label="Spatial Radar and Signal Scanner"
    >
      {scannerOpen && (
        <div className="void-scanner-drawer" data-testid="signal-scanner-drawer">
          <div className="void-scanner-header">
            <span>
              ACTIVE SIGNALS ({totalActiveObjects}) · {activeSectors}{' '}
              {activeSectors === 1 ? 'SECTOR' : 'SECTORS'}
            </span>
            <button
              type="button"
              className="void-mini-btn"
              data-testid="warp-uncharted-btn"
              title="Jump to an unexplored sector in the infinite world"
              onClick={onWarpUncharted}
            >
              uncharted ↗
            </button>
          </div>
          <div className="void-scanner-list">
            {sortedSignals.length === 0 ? (
              <div className="void-scanner-empty">no active signals detected across the void</div>
            ) : (
              sortedSignals.slice(0, 40).map(({ sig, cx, cy, dist }) => (
                <button
                  key={sig.id}
                  type="button"
                  className={`void-scanner-row ${sig.id === selectedObjectId ? 'active' : ''}`}
                  data-testid={`scanner-signal-${sig.id}`}
                  onClick={() => onWarpTo(Math.round(cx), Math.round(cy), sig.id)}
                >
                  <div className="void-scanner-row-main">
                    <span className="void-scanner-id">#{sig.id.slice(0, 6)}</span>
                    <span className="void-object-rev">r{sig.revision}</span>
                    <span className="void-scanner-sector">
                      [{sig.chunkX}:{sig.chunkY}]
                    </span>
                  </div>
                  <div className="void-scanner-row-sub">
                    <span>
                      ({Math.round(sig.x)}, {Math.round(sig.y)})
                    </span>
                    <span>
                      {dist < 1000 ? `${dist}u` : `${(dist / 1000).toFixed(1)}ku`} ·{' '}
                      {formatRelativeTime(sig.updatedAt, nowMs)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="void-radar-card">
        <div className="void-radar-bar">
          <span className="void-radar-sector" data-testid="hud-sector-coords">
            SEC [{currentChunkX}:{currentChunkY}]
          </span>
          <div className="void-radar-actions">
            <button
              type="button"
              className="void-mini-btn"
              data-testid="toggle-scanner-btn"
              onClick={() => setScannerOpen((prev) => !prev)}
            >
              {scannerOpen ? 'close' : `signals (${totalActiveObjects})`}
            </button>
            <button
              type="button"
              className="void-mini-btn"
              data-testid="radar-uncharted-btn"
              title="Warp to an uncharted frontier sector"
              onClick={onWarpUncharted}
            >
              frontier
            </button>
          </div>
        </div>

        <svg
          width={RADAR_SIZE}
          height={RADAR_SIZE}
          viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
          className="void-radar-svg"
          data-testid="radar-scope-svg"
          onClick={handleRadarClick}
        >
          {/* Range rings & crosshairs */}
          <circle
            cx={RADAR_HALF}
            cy={RADAR_HALF}
            r={RADAR_HALF - 10}
            className="void-radar-ring"
          />
          <circle
            cx={RADAR_HALF}
            cy={RADAR_HALF}
            r={(RADAR_HALF - 10) * 0.5}
            className="void-radar-ring-inner"
          />
          <line
            x1={RADAR_HALF}
            y1={0}
            x2={RADAR_HALF}
            y2={RADAR_SIZE}
            className="void-radar-axis"
          />
          <line
            x1={0}
            y1={RADAR_HALF}
            x2={RADAR_SIZE}
            y2={RADAR_HALF}
            className="void-radar-axis"
          />

          {/* Origin (0,0) crosshair on radar if within range */}
          {originInScope && (
            <g transform={`translate(${RADAR_HALF + originDx}, ${RADAR_HALF + originDy})`}>
              <rect
                x={-2.5}
                y={-2.5}
                width={5}
                height={5}
                transform="rotate(45)"
                className="void-radar-origin"
              />
            </g>
          )}

          {/* Active world signals (in-scope rectangles + out-of-scope directional edge blips) */}
          {sortedSignals.map(({ sig, cx, cy }) => {
            const dx = (cx - camera.x) * scale;
            const dy = (cy - camera.y) * scale;
            const isSelected = sig.id === selectedObjectId;

            if (Math.abs(dx) <= RADAR_HALF - 8 && Math.abs(dy) <= RADAR_HALF - 8) {
              const rw = Math.max(3, Math.min(18, sig.width * scale));
              const rh = Math.max(3, Math.min(18, sig.height * scale));
              return (
                <rect
                  key={sig.id}
                  x={RADAR_HALF + dx - rw / 2}
                  y={RADAR_HALF + dy - rh / 2}
                  width={rw}
                  height={rh}
                  className={`void-radar-blip ${isSelected ? 'selected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onWarpTo(Math.round(cx), Math.round(cy), sig.id);
                  }}
                >
                  <title>
                    #{sig.id.slice(0, 6)} @ ({Math.round(sig.x)}, {Math.round(sig.y)})
                  </title>
                </rect>
              );
            }

            // Directional perimeter vector blip for distant signals across the infinite world
            const angle = Math.atan2(dy, dx);
            const edgeR = RADAR_HALF - 6;
            const ex = RADAR_HALF + Math.cos(angle) * edgeR;
            const ey = RADAR_HALF + Math.sin(angle) * edgeR;

            return (
              <circle
                key={sig.id}
                cx={ex}
                cy={ey}
                r={2.5}
                className={`void-radar-edge-blip ${isSelected ? 'selected' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onWarpTo(Math.round(cx), Math.round(cy), sig.id);
                }}
              >
                <title>
                  Distant signal #{sig.id.slice(0, 6)} @ ({Math.round(sig.x)}, {Math.round(sig.y)})
                </title>
              </circle>
            );
          })}

          {/* Anonymous visitor cursors */}
          {Object.values(cursors).map((cur) => {
            const dx = (cur.x - camera.x) * scale;
            const dy = (cur.y - camera.y) * scale;
            if (Math.abs(dx) > RADAR_HALF - 4 || Math.abs(dy) > RADAR_HALF - 4) return null;
            return (
              <circle
                key={cur.sessionId}
                cx={RADAR_HALF + dx}
                cy={RADAR_HALF + dy}
                r={2}
                className="void-radar-cursor"
              />
            );
          })}

          {/* Current Camera Viewport Box */}
          <rect
            x={RADAR_HALF - vpW / 2}
            y={RADAR_HALF - vpH / 2}
            width={vpW}
            height={vpH}
            className="void-radar-viewport"
          />
        </svg>

        <div className="void-radar-footer">
          <span>±{Math.round(radarWorldRadius / CHUNK_SIZE)} sectors</span>
          <span>click scope to warp</span>
        </div>
      </div>
    </aside>
  );
}
