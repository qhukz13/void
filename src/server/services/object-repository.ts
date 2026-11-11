import crypto from 'node:crypto';
import {
  DEFAULT_NEW_OBJECT_CSS,
  DEFAULT_NEW_OBJECT_HTML,
  DEFAULT_NEW_OBJECT_JS,
  MAX_OBJECT_HEIGHT,
  MAX_OBJECT_WIDTH,
  MAX_ROTATION,
  MAX_Z_INDEX,
  MIN_OBJECT_HEIGHT,
  MIN_OBJECT_WIDTH,
  MIN_ROTATION,
  MIN_Z_INDEX,
  WORLD_MAX_COORD,
  WORLD_MIN_COORD
} from '../../shared/constants.js';
import {
  clampCoord,
  clampHeight,
  clampRotation,
  clampWidth,
  clampZIndex,
  coordToChunkIndex,
  isValidFiniteNumber
} from '../../shared/spatial.js';
import type {
  BoundingBox,
  CreateObjectInput,
  ObjectRevisionDetail,
  ObjectRevisionSummary,
  RevisionEventType,
  UpdateObjectInput,
  VoidObject,
  WorldSignalBeacon
} from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import type { DatabaseAdapter } from '../db/adapter.js';

export class DomainError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

interface WorldObjectRow {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  max_x: number;
  max_y: number;
  chunk_x: number;
  chunk_y: number;
  rotation: number;
  z_index: number;
  html: string;
  css: string;
  javascript: string;
  revision: number;
  deleted: boolean;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ObjectRevisionRow {
  id: number | string;
  object_id: string;
  revision: number;
  event_type: RevisionEventType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z_index: number;
  html?: string;
  css?: string;
  javascript?: string;
  html_bytes: number;
  css_bytes: number;
  js_bytes: number;
  created_at: Date | string;
}

function toIsoString(val: Date | string | null | undefined): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? String(val) : parsed.toISOString();
}

function mapObjectRow(row: WorldObjectRow): VoidObject {
  return {
    id: row.id,
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    rotation: Number(row.rotation),
    zIndex: Number(row.z_index),
    html: row.html,
    css: row.css,
    javascript: row.javascript,
    revision: Number(row.revision),
    deleted: Boolean(row.deleted),
    deletedAt: row.deleted_at ? toIsoString(row.deleted_at) : null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapRevisionSummaryRow(row: ObjectRevisionRow): ObjectRevisionSummary {
  return {
    id: Number(row.id),
    objectId: row.object_id,
    revision: Number(row.revision),
    eventType: row.event_type,
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    rotation: Number(row.rotation),
    zIndex: Number(row.z_index),
    htmlBytes: Number(row.html_bytes),
    cssBytes: Number(row.css_bytes),
    jsBytes: Number(row.js_bytes),
    createdAt: toIsoString(row.created_at)
  };
}

function mapRevisionDetailRow(row: ObjectRevisionRow): ObjectRevisionDetail {
  return {
    ...mapRevisionSummaryRow(row),
    html: row.html ?? '',
    css: row.css ?? '',
    javascript: row.javascript ?? ''
  };
}

function sanitizeSourceString(raw: unknown, fieldName: string, maxBytes: number): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new DomainError(400, 'INVALID_SOURCE_TYPE', `${fieldName} must be a string`);
  }
  // Remove null bytes which PostgreSQL UTF-8 text columns reject
  const cleaned = raw.replace(/\u0000/g, '');
  const byteLen = Buffer.byteLength(cleaned, 'utf8');
  if (byteLen > maxBytes) {
    throw new DomainError(
      413,
      'SOURCE_TOO_LARGE',
      `${fieldName} exceeds maximum size of ${maxBytes} bytes (got ${byteLen} bytes)`
    );
  }
  return cleaned;
}

export function validateObjectId(id: unknown): string {
  if (typeof id !== 'string') {
    throw new DomainError(400, 'INVALID_OBJECT_ID', 'Object ID must be a string');
  }
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(trimmed)) {
    throw new DomainError(400, 'INVALID_OBJECT_ID', 'Object ID format is invalid');
  }
  return trimmed;
}

function validateCoordStrict(val: unknown, name: string): number {
  if (!isValidFiniteNumber(val)) {
    throw new DomainError(400, 'INVALID_COORDINATE', `${name} must be a finite number`);
  }
  if (val < WORLD_MIN_COORD || val > WORLD_MAX_COORD) {
    throw new DomainError(
      400,
      'COORDINATE_OUT_OF_RANGE',
      `${name} must be between ${WORLD_MIN_COORD} and ${WORLD_MAX_COORD}`
    );
  }
  return clampCoord(val);
}

function validateDimensionStrict(val: unknown, name: string, min: number, max: number): number {
  if (!isValidFiniteNumber(val)) {
    throw new DomainError(400, 'INVALID_DIMENSION', `${name} must be a finite number`);
  }
  if (val < min || val > max) {
    throw new DomainError(400, 'DIMENSION_OUT_OF_RANGE', `${name} must be between ${min} and ${max}`);
  }
  return Math.round(val);
}

export class ObjectRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly config: ServerConfig
  ) {}

  async getActiveObjectCount(): Promise<number> {
    const res = await this.db.query<{ count: string | number }>(
      'SELECT COUNT(*) AS count FROM world_objects WHERE deleted = FALSE'
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async getWorldSignals(limit = 200): Promise<{
    signals: WorldSignalBeacon[];
    totalActiveObjects: number;
    activeSectors: number;
  }> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const [signalsRes, statsRes] = await Promise.all([
      this.db.query<
        Pick<
          WorldObjectRow,
          'id' | 'x' | 'y' | 'width' | 'height' | 'chunk_x' | 'chunk_y' | 'revision' | 'updated_at'
        >
      >(
        `SELECT id, x, y, width, height, chunk_x, chunk_y, revision, updated_at
         FROM world_objects
         WHERE deleted = FALSE
         ORDER BY updated_at DESC
         LIMIT $1`,
        [safeLimit]
      ),
      this.db.query<{ total_objects: string | number; total_sectors: string | number }>(
        `SELECT
           COUNT(*) AS total_objects,
           COUNT(DISTINCT (chunk_x::text || ':' || chunk_y::text)) AS total_sectors
         FROM world_objects
         WHERE deleted = FALSE`
      )
    ]);

    const signals: WorldSignalBeacon[] = signalsRes.rows.map((r) => ({
      id: r.id,
      x: Number(r.x),
      y: Number(r.y),
      width: Number(r.width),
      height: Number(r.height),
      chunkX: Number(r.chunk_x),
      chunkY: Number(r.chunk_y),
      revision: Number(r.revision),
      updatedAt: toIsoString(r.updated_at)
    }));

    return {
      signals,
      totalActiveObjects: Number(statsRes.rows[0]?.total_objects ?? signals.length),
      activeSectors: Number(statsRes.rows[0]?.total_sectors ?? 0)
    };
  }

  async getRegionObjects(bounds: BoundingBox, requestedLimit?: number): Promise<VoidObject[]> {
    const minX = clampCoord(Math.min(bounds.minX, bounds.maxX));
    const maxX = clampCoord(Math.max(bounds.minX, bounds.maxX));
    const minY = clampCoord(Math.min(bounds.minY, bounds.maxY));
    const maxY = clampCoord(Math.max(bounds.minY, bounds.maxY));

    const limit = Math.max(
      1,
      Math.min(
        this.config.maxObjectsPerRegionQuery,
        requestedLimit && Number.isFinite(requestedLimit)
          ? Math.floor(requestedLimit)
          : this.config.maxObjectsPerRegionQuery
      )
    );

    const res = await this.db.query<WorldObjectRow>(
      `SELECT *
       FROM world_objects
       WHERE deleted = FALSE
         AND max_x >= $1
         AND x <= $2
         AND max_y >= $3
         AND y <= $4
       ORDER BY z_index ASC, created_at ASC
       LIMIT $5`,
      [minX, maxX, minY, maxY, limit]
    );

    return res.rows.map(mapObjectRow);
  }

  async getObjectById(rawId: string, includeDeleted = false): Promise<VoidObject | null> {
    const id = validateObjectId(rawId);
    const res = await this.db.query<WorldObjectRow>(
      'SELECT * FROM world_objects WHERE id = $1',
      [id]
    );
    if (res.rows.length === 0) return null;
    const obj = mapObjectRow(res.rows[0]);
    if (obj.deleted && !includeDeleted) {
      return null;
    }
    return obj;
  }

  async createObject(input: CreateObjectInput): Promise<{
    object: VoidObject;
    revision: ObjectRevisionSummary;
  }> {
    const x = validateCoordStrict(input.x, 'x');
    const y = validateCoordStrict(input.y, 'y');

    const width =
      input.width !== undefined
        ? validateDimensionStrict(input.width, 'width', MIN_OBJECT_WIDTH, MAX_OBJECT_WIDTH)
        : clampWidth(undefined);
    const height =
      input.height !== undefined
        ? validateDimensionStrict(input.height, 'height', MIN_OBJECT_HEIGHT, MAX_OBJECT_HEIGHT)
        : clampHeight(undefined);

    if (input.rotation !== undefined) {
      if (!isValidFiniteNumber(input.rotation) || input.rotation < MIN_ROTATION || input.rotation > MAX_ROTATION) {
        throw new DomainError(400, 'INVALID_ROTATION', `rotation must be between ${MIN_ROTATION} and ${MAX_ROTATION}`);
      }
    }
    const rotation = clampRotation(input.rotation);

    if (input.zIndex !== undefined) {
      if (!isValidFiniteNumber(input.zIndex) || input.zIndex < MIN_Z_INDEX || input.zIndex > MAX_Z_INDEX) {
        throw new DomainError(400, 'INVALID_Z_INDEX', `zIndex must be between ${MIN_Z_INDEX} and ${MAX_Z_INDEX}`);
      }
    }
    const zIndex = clampZIndex(input.zIndex);

    const html =
      input.html !== undefined
        ? sanitizeSourceString(input.html, 'html', this.config.maxHtmlBytes)
        : DEFAULT_NEW_OBJECT_HTML;
    const css =
      input.css !== undefined
        ? sanitizeSourceString(input.css, 'css', this.config.maxCssBytes)
        : DEFAULT_NEW_OBJECT_CSS;
    const javascript =
      input.javascript !== undefined
        ? sanitizeSourceString(input.javascript, 'javascript', this.config.maxJsBytes)
        : DEFAULT_NEW_OBJECT_JS;

    const id = crypto.randomUUID();
    const maxX = x + width;
    const maxY = y + height;
    const chunkX = coordToChunkIndex(x);
    const chunkY = coordToChunkIndex(y);

    const htmlBytes = Buffer.byteLength(html, 'utf8');
    const cssBytes = Buffer.byteLength(css, 'utf8');
    const jsBytes = Buffer.byteLength(javascript, 'utf8');

    return this.db.withTransaction(async (tx) => {
      const objRes = await tx.query<WorldObjectRow>(
        `INSERT INTO world_objects (
          id, x, y, width, height, max_x, max_y, chunk_x, chunk_y,
          rotation, z_index, html, css, javascript, revision, deleted, deleted_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, 1, FALSE, NULL, NOW(), NOW()
        ) RETURNING *`,
        [id, x, y, width, height, maxX, maxY, chunkX, chunkY, rotation, zIndex, html, css, javascript]
      );

      const revRes = await tx.query<ObjectRevisionRow>(
        `INSERT INTO object_revisions (
          object_id, revision, event_type, x, y, width, height, rotation, z_index,
          html, css, javascript, html_bytes, css_bytes, js_bytes, created_at
        ) VALUES (
          $1, 1, 'created', $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, NOW()
        ) RETURNING id, object_id, revision, event_type, x, y, width, height, rotation, z_index, html_bytes, css_bytes, js_bytes, created_at`,
        [id, x, y, width, height, rotation, zIndex, html, css, javascript, htmlBytes, cssBytes, jsBytes]
      );

      return {
        object: mapObjectRow(objRes.rows[0]),
        revision: mapRevisionSummaryRow(revRes.rows[0])
      };
    });
  }

  async updateObject(
    rawId: string,
    input: UpdateObjectInput
  ): Promise<{
    object: VoidObject;
    previousObject: VoidObject;
    revision: ObjectRevisionSummary;
    eventType: 'updated' | 'moved' | 'resized';
  }> {
    const id = validateObjectId(rawId);

    // Pre-validate provided fields before entering transaction
    const nextX = input.x !== undefined ? validateCoordStrict(input.x, 'x') : undefined;
    const nextY = input.y !== undefined ? validateCoordStrict(input.y, 'y') : undefined;
    const nextWidth =
      input.width !== undefined
        ? validateDimensionStrict(input.width, 'width', MIN_OBJECT_WIDTH, MAX_OBJECT_WIDTH)
        : undefined;
    const nextHeight =
      input.height !== undefined
        ? validateDimensionStrict(input.height, 'height', MIN_OBJECT_HEIGHT, MAX_OBJECT_HEIGHT)
        : undefined;

    if (input.rotation !== undefined) {
      if (!isValidFiniteNumber(input.rotation) || input.rotation < MIN_ROTATION || input.rotation > MAX_ROTATION) {
        throw new DomainError(400, 'INVALID_ROTATION', `rotation must be between ${MIN_ROTATION} and ${MAX_ROTATION}`);
      }
    }
    const nextRotation = input.rotation !== undefined ? clampRotation(input.rotation) : undefined;

    if (input.zIndex !== undefined) {
      if (!isValidFiniteNumber(input.zIndex) || input.zIndex < MIN_Z_INDEX || input.zIndex > MAX_Z_INDEX) {
        throw new DomainError(400, 'INVALID_Z_INDEX', `zIndex must be between ${MIN_Z_INDEX} and ${MAX_Z_INDEX}`);
      }
    }
    const nextZIndex = input.zIndex !== undefined ? clampZIndex(input.zIndex) : undefined;

    if (input.expectedRevision !== undefined) {
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new DomainError(400, 'INVALID_REVISION', 'expectedRevision must be a positive integer');
      }
    }

    const nextHtml =
      input.html !== undefined
        ? sanitizeSourceString(input.html, 'html', this.config.maxHtmlBytes)
        : undefined;
    const nextCss =
      input.css !== undefined
        ? sanitizeSourceString(input.css, 'css', this.config.maxCssBytes)
        : undefined;
    const nextJs =
      input.javascript !== undefined
        ? sanitizeSourceString(input.javascript, 'javascript', this.config.maxJsBytes)
        : undefined;

    return this.db.withTransaction(async (tx) => {
      const existingRes = await tx.query<WorldObjectRow>(
        'SELECT * FROM world_objects WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (existingRes.rows.length === 0) {
        throw new DomainError(404, 'OBJECT_NOT_FOUND', `Object ${id} does not exist`);
      }

      const previousObject = mapObjectRow(existingRes.rows[0]);
      if (previousObject.deleted) {
        throw new DomainError(410, 'OBJECT_DELETED', `Object ${id} has been deleted from the active world`);
      }

      const x = nextX ?? previousObject.x;
      const y = nextY ?? previousObject.y;
      const width = nextWidth ?? previousObject.width;
      const height = nextHeight ?? previousObject.height;
      const rotation = nextRotation ?? previousObject.rotation;
      const zIndex = nextZIndex ?? previousObject.zIndex;
      const html = nextHtml ?? previousObject.html;
      const css = nextCss ?? previousObject.css;
      const javascript = nextJs ?? previousObject.javascript;

      const codeChanged =
        html !== previousObject.html ||
        css !== previousObject.css ||
        javascript !== previousObject.javascript ||
        input.html !== undefined ||
        input.css !== undefined ||
        input.javascript !== undefined;
      const sizeChanged = width !== previousObject.width || height !== previousObject.height;

      const eventType: 'updated' | 'moved' | 'resized' = codeChanged
        ? 'updated'
        : sizeChanged
          ? 'resized'
          : 'moved';

      const nextRevision = previousObject.revision + 1;
      const maxX = x + width;
      const maxY = y + height;
      const chunkX = coordToChunkIndex(x);
      const chunkY = coordToChunkIndex(y);

      const htmlBytes = Buffer.byteLength(html, 'utf8');
      const cssBytes = Buffer.byteLength(css, 'utf8');
      const jsBytes = Buffer.byteLength(javascript, 'utf8');

      const updatedRes = await tx.query<WorldObjectRow>(
        `UPDATE world_objects
         SET x = $2,
             y = $3,
             width = $4,
             height = $5,
             max_x = $6,
             max_y = $7,
             chunk_x = $8,
             chunk_y = $9,
             rotation = $10,
             z_index = $11,
             html = $12,
             css = $13,
             javascript = $14,
             revision = $15,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, x, y, width, height, maxX, maxY, chunkX, chunkY, rotation, zIndex, html, css, javascript, nextRevision]
      );

      const revRes = await tx.query<ObjectRevisionRow>(
        `INSERT INTO object_revisions (
          object_id, revision, event_type, x, y, width, height, rotation, z_index,
          html, css, javascript, html_bytes, css_bytes, js_bytes, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, NOW()
        ) RETURNING id, object_id, revision, event_type, x, y, width, height, rotation, z_index, html_bytes, css_bytes, js_bytes, created_at`,
        [
          id,
          nextRevision,
          eventType,
          x,
          y,
          width,
          height,
          rotation,
          zIndex,
          html,
          css,
          javascript,
          htmlBytes,
          cssBytes,
          jsBytes
        ]
      );

      // Prune oldest intermediate revisions if exceeding maxRevisionsPerObject, always preserving revision 1
      if (nextRevision > this.config.maxRevisionsPerObject) {
        const minKeepRevision = nextRevision - this.config.maxRevisionsPerObject + 2;
        await tx.query(
          `DELETE FROM object_revisions
           WHERE object_id = $1
             AND revision > 1
             AND revision < $2`,
          [id, minKeepRevision]
        );
      }

      return {
        object: mapObjectRow(updatedRes.rows[0]),
        previousObject,
        revision: mapRevisionSummaryRow(revRes.rows[0]),
        eventType
      };
    });
  }

  async deleteObject(rawId: string): Promise<{
    objectId: string;
    revision: number;
    deletedAt: string;
    previousObject: VoidObject;
    revisionSummary: ObjectRevisionSummary;
  }> {
    const id = validateObjectId(rawId);

    return this.db.withTransaction(async (tx) => {
      const existingRes = await tx.query<WorldObjectRow>(
        'SELECT * FROM world_objects WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (existingRes.rows.length === 0) {
        throw new DomainError(404, 'OBJECT_NOT_FOUND', `Object ${id} does not exist`);
      }

      const previousObject = mapObjectRow(existingRes.rows[0]);
      if (previousObject.deleted) {
        throw new DomainError(410, 'OBJECT_ALREADY_DELETED', `Object ${id} is already deleted`);
      }

      const nextRevision = previousObject.revision + 1;
      const htmlBytes = Buffer.byteLength(previousObject.html, 'utf8');
      const cssBytes = Buffer.byteLength(previousObject.css, 'utf8');
      const jsBytes = Buffer.byteLength(previousObject.javascript, 'utf8');

      const delRes = await tx.query<WorldObjectRow>(
        `UPDATE world_objects
         SET deleted = TRUE,
             deleted_at = NOW(),
             updated_at = NOW(),
             revision = $2
         WHERE id = $1
         RETURNING *`,
        [id, nextRevision]
      );

      const revRes = await tx.query<ObjectRevisionRow>(
        `INSERT INTO object_revisions (
          object_id, revision, event_type, x, y, width, height, rotation, z_index,
          html, css, javascript, html_bytes, css_bytes, js_bytes, created_at
        ) VALUES (
          $1, $2, 'deleted', $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, NOW()
        ) RETURNING id, object_id, revision, event_type, x, y, width, height, rotation, z_index, html_bytes, css_bytes, js_bytes, created_at`,
        [
          id,
          nextRevision,
          previousObject.x,
          previousObject.y,
          previousObject.width,
          previousObject.height,
          previousObject.rotation,
          previousObject.zIndex,
          previousObject.html,
          previousObject.css,
          previousObject.javascript,
          htmlBytes,
          cssBytes,
          jsBytes
        ]
      );

      const updatedRow = delRes.rows[0];
      return {
        objectId: id,
        revision: nextRevision,
        deletedAt: toIsoString(updatedRow.deleted_at),
        previousObject,
        revisionSummary: mapRevisionSummaryRow(revRes.rows[0])
      };
    });
  }

  async getObjectRevisions(rawId: string): Promise<{
    object: VoidObject;
    revisions: ObjectRevisionSummary[];
  }> {
    const id = validateObjectId(rawId);
    const obj = await this.getObjectById(id, true);
    if (!obj) {
      throw new DomainError(404, 'OBJECT_NOT_FOUND', `Object ${id} does not exist`);
    }

    const revRes = await this.db.query<ObjectRevisionRow>(
      `SELECT id, object_id, revision, event_type, x, y, width, height, rotation, z_index,
              html_bytes, css_bytes, js_bytes, created_at
       FROM object_revisions
       WHERE object_id = $1
       ORDER BY revision DESC`,
      [id]
    );

    return {
      object: obj,
      revisions: revRes.rows.map(mapRevisionSummaryRow)
    };
  }

  async getObjectRevisionDetail(rawId: string, revisionNum: number): Promise<ObjectRevisionDetail> {
    const id = validateObjectId(rawId);
    if (!Number.isInteger(revisionNum) || revisionNum < 1) {
      throw new DomainError(400, 'INVALID_REVISION', 'Revision number must be a positive integer');
    }

    const revRes = await this.db.query<ObjectRevisionRow>(
      `SELECT *
       FROM object_revisions
       WHERE object_id = $1 AND revision = $2`,
      [id, revisionNum]
    );

    if (revRes.rows.length === 0) {
      throw new DomainError(404, 'REVISION_NOT_FOUND', `Revision ${revisionNum} for object ${id} not found`);
    }

    return mapRevisionDetailRow(revRes.rows[0]);
  }

  async seedInitialObjectIfEmpty(): Promise<VoidObject | null> {
    if (!this.config.seedInitialObject) return null;

    const totalRes = await this.db.query<{ count: string | number }>(
      'SELECT COUNT(*) AS count FROM world_objects'
    );
    const total = Number(totalRes.rows[0]?.count ?? 0);
    if (total > 0) return null;

    const created = await this.createObject({
      x: -180,
      y: -130,
      width: 360,
      height: 260,
      html: `<div class="origin-beacon">
  <pre class="ascii">+----------------------------+
|     THE VOID // (0, 0)     |
+----------------------------+</pre>
  <p>unmoderated programmable space. raw html / css / js.</p>
  <hr />
  <div class="row">
    <button id="mut">PING [0]</button>
    <span id="sig-readout" class="sig">LIVE</span>
  </div>
</div>`,
      css: `body {
  margin: 0;
  padding: 10px;
  height: 100%;
  display: grid;
  place-items: center;
  background: #000000;
  color: #f0f0f0;
  font-family: 'Courier New', Courier, monospace;
}
.origin-beacon {
  width: 100%;
  padding: 10px;
  background: #080808;
  border: 1px solid #555555;
  box-shadow: 3px 3px 0 #1b1b1b;
}
.ascii {
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.15;
  color: #ffb000;
}
p {
  font-size: 12px;
  color: #b8b8b8;
  margin: 0 0 8px;
}
hr {
  border: 0;
  border-top: 1px dashed #444444;
  margin: 8px 0;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
button {
  background: #141414;
  color: #00ff66;
  border: 1px solid #00ff66;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 12px;
  font-weight: bold;
  cursor: pointer;
}
button:hover {
  background: #00ff66;
  color: #000000;
}
.sig {
  font-size: 11px;
  color: #00ff66;
}`,
      javascript: `const btn = document.getElementById('mut');
const sig = document.getElementById('sig-readout');
let pulses = 0;
if (btn) {
  btn.addEventListener('click', () => {
    pulses += 1;
    btn.textContent = 'PING [' + pulses + ']';
    if (sig) sig.textContent = 'ACK #' + pulses;
  });
}`
    });

    return created.object;
  }
}
