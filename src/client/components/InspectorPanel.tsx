import React, { useCallback, useEffect, useState } from 'react';
import { formatRelativeTime } from '../../shared/spatial.js';
import type {
  CreateObjectInput,
  ObjectRevisionDetail,
  ObjectRevisionSummary,
  SandboxDiagnostic,
  UpdateObjectInput,
  VoidObject
} from '../../shared/types.js';
import type { VoidApiClient } from '../services/void-client.js';
import { CodeEditorSurface } from './CodeEditorSurface.js';

type InspectorTab = 'html' | 'css' | 'javascript' | 'history';

interface InspectorPanelProps {
  object: VoidObject;
  apiClient: VoidApiClient;
  diagnostics: SandboxDiagnostic[];
  nowMs: number;
  revisionBumpToken: number;
  onClose: () => void;
  onSaveObject: (objectId: string, patch: UpdateObjectInput) => Promise<VoidObject>;
  onCopyIntoNewObject: (input: CreateObjectInput) => Promise<VoidObject>;
  onDeleteObject: (objectId: string) => Promise<void>;
  onClearDiagnostics: (objectId: string) => void;
}

export function InspectorPanel({
  object,
  apiClient,
  diagnostics,
  nowMs,
  revisionBumpToken,
  onClose,
  onSaveObject,
  onCopyIntoNewObject,
  onDeleteObject,
  onClearDiagnostics
}: InspectorPanelProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('html');

  const [draftHtml, setDraftHtml] = useState(object.html);
  const [draftCss, setDraftCss] = useState(object.css);
  const [draftJs, setDraftJs] = useState(object.javascript);
  const [draftX, setDraftX] = useState(String(Math.round(object.x)));
  const [draftY, setDraftY] = useState(String(Math.round(object.y)));
  const [draftW, setDraftW] = useState(String(object.width));
  const [draftH, setDraftH] = useState(String(object.height));
  const [draftRot, setDraftRot] = useState(String(Math.round(object.rotation)));
  const [draftZ, setDraftZ] = useState(String(object.zIndex));
  const [isDirty, setIsDirty] = useState(false);

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedFeedback, setCopiedFeedback] = useState<string | null>(null);

  // History Archaeology state
  const [revisions, setRevisions] = useState<ObjectRevisionSummary[]>([]);
  const [selectedRevisionNum, setSelectedRevisionNum] = useState<number | null>(null);
  const [selectedRevisionDetail, setSelectedRevisionDetail] = useState<ObjectRevisionDetail | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Sync draft state when switching objects or when remote updates arrive while not dirty
  useEffect(() => {
    setDraftHtml(object.html);
    setDraftCss(object.css);
    setDraftJs(object.javascript);
    setDraftX(String(Math.round(object.x)));
    setDraftY(String(Math.round(object.y)));
    setDraftW(String(object.width));
    setDraftH(String(object.height));
    setDraftRot(String(Math.round(object.rotation)));
    setDraftZ(String(object.zIndex));
    setIsDirty(false);
    setSaveState('idle');
    setSaveError(null);
  }, [object.id]);

  useEffect(() => {
    if (!isDirty) {
      setDraftHtml(object.html);
      setDraftCss(object.css);
      setDraftJs(object.javascript);
      setDraftX(String(Math.round(object.x)));
      setDraftY(String(Math.round(object.y)));
      setDraftW(String(object.width));
      setDraftH(String(object.height));
      setDraftRot(String(Math.round(object.rotation)));
      setDraftZ(String(object.zIndex));
    }
  }, [
    isDirty,
    object.revision,
    object.html,
    object.css,
    object.javascript,
    object.x,
    object.y,
    object.width,
    object.height,
    object.rotation,
    object.zIndex
  ]);

  const loadRevisions = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await apiClient.fetchRevisions(object.id);
      setRevisions(data.revisions);
      if (data.revisions.length > 0) {
        const targetRev =
          selectedRevisionNum && data.revisions.some((r) => r.revision === selectedRevisionNum)
            ? selectedRevisionNum
            : data.revisions[0].revision;
        setSelectedRevisionNum(targetRev);
        const detail = await apiClient.fetchRevisionDetail(object.id, targetRev);
        setSelectedRevisionDetail(detail);
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  }, [apiClient, object.id, selectedRevisionNum]);

  useEffect(() => {
    if (activeTab === 'history') {
      void loadRevisions();
    }
  }, [activeTab, object.id, object.revision, revisionBumpToken, loadRevisions]);

  const handleSelectRevision = async (revNum: number) => {
    setSelectedRevisionNum(revNum);
    setHistoryError(null);
    try {
      const detail = await apiClient.fetchRevisionDetail(object.id, revNum);
      setSelectedRevisionDetail(detail);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load revision source');
    }
  };

  const handleRunAndCommit = async () => {
    setSaveState('saving');
    setSaveError(null);
    onClearDiagnostics(object.id);

    const parsedX = Number(draftX);
    const parsedY = Number(draftY);
    const parsedW = Number(draftW);
    const parsedH = Number(draftH);
    const parsedRot = Number(draftRot);
    const parsedZ = Number(draftZ);

    try {
      await onSaveObject(object.id, {
        html: draftHtml,
        css: draftCss,
        javascript: draftJs,
        x: Number.isFinite(parsedX) ? parsedX : object.x,
        y: Number.isFinite(parsedY) ? parsedY : object.y,
        width: Number.isFinite(parsedW) ? parsedW : object.width,
        height: Number.isFinite(parsedH) ? parsedH : object.height,
        rotation: Number.isFinite(parsedRot) ? parsedRot : object.rotation,
        zIndex: Number.isFinite(parsedZ) ? parsedZ : object.zIndex
      });
      setIsDirty(false);
      setSaveState('saved');
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    }
  };

  const handleCopyCurrentIntoNew = async () => {
    setSaveState('saving');
    setSaveError(null);
    try {
      await onCopyIntoNewObject({
        x: object.x + 48,
        y: object.y + 48,
        width: object.width,
        height: object.height,
        html: draftHtml,
        css: draftCss,
        javascript: draftJs
      });
      setCopiedFeedback('spawned independent copy');
      setTimeout(() => setCopiedFeedback(null), 2000);
      setSaveState('idle');
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Failed to copy object');
    }
  };

  const handleCopySourceClipboard = async (src: { html: string; css: string; javascript: string }) => {
    const bundle = `<!-- HTML -->\n${src.html}\n\n/* CSS */\n${src.css}\n\n// JS\n${src.javascript}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(bundle);
      }
    } catch (_) {}
    setCopiedFeedback('copied source');
    setTimeout(() => setCopiedFeedback(null), 2000);
  };

  const handleSpawnFromHistoricalRevision = async (rev: ObjectRevisionDetail) => {
    try {
      await onCopyIntoNewObject({
        x: object.x + 56,
        y: object.y + 56,
        width: rev.width,
        height: rev.height,
        html: rev.html,
        css: rev.css,
        javascript: rev.javascript
      });
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to spawn object from revision');
    }
  };

  return (
    <aside className="void-inspector" data-testid="inspector-panel" aria-label="Object Inspector">
      <div className="void-inspector-header">
        <div className="void-inspector-title-row">
          <div className="void-inspector-identity">
            <span className="void-inspector-id" data-testid="inspector-object-id">
              OBJECT #{object.id.slice(0, 8)}
            </span>
            <span className="void-object-rev" data-testid="inspector-object-revision">
              r{object.revision}
            </span>
          </div>
          <button
            type="button"
            className="void-btn"
            data-testid="inspector-close-btn"
            onClick={onClose}
          >
            close [esc]
          </button>
        </div>

        <div className="void-inspector-timestamps">
          <span>created {formatRelativeTime(object.createdAt, nowMs)}</span>
          <span>·</span>
          <span>last modified {formatRelativeTime(object.updatedAt, nowMs)}</span>
        </div>

        <div className="void-inspector-toolbar">
          <button
            type="button"
            className="void-btn primary"
            data-testid="inspector-run-btn"
            disabled={saveState === 'saving'}
            onClick={() => void handleRunAndCommit()}
          >
            {saveState === 'saving' ? 'committing...' : 'run / commit'}
          </button>

          <button
            type="button"
            className="void-btn"
            data-testid="inspector-copy-btn"
            onClick={() => void handleCopyCurrentIntoNew()}
          >
            copy to new object
          </button>

          <button
            type="button"
            className="void-btn"
            data-testid="inspector-clipboard-btn"
            onClick={() =>
              void handleCopySourceClipboard({
                html: draftHtml,
                css: draftCss,
                javascript: draftJs
              })
            }
          >
            copy source
          </button>

          <button
            type="button"
            className="void-btn danger"
            data-testid="inspector-delete-btn"
            onClick={() => void onDeleteObject(object.id)}
          >
            delete object
          </button>
        </div>
      </div>

      <div className="void-spatial-row">
        <div className="void-spatial-field">
          <label htmlFor="insp-x">X</label>
          <input
            id="insp-x"
            type="number"
            data-testid="inspector-input-x"
            value={draftX}
            onChange={(e) => {
              setDraftX(e.target.value);
              setIsDirty(true);
            }}
          />
        </div>
        <div className="void-spatial-field">
          <label htmlFor="insp-y">Y</label>
          <input
            id="insp-y"
            type="number"
            data-testid="inspector-input-y"
            value={draftY}
            onChange={(e) => {
              setDraftY(e.target.value);
              setIsDirty(true);
            }}
          />
        </div>
        <div className="void-spatial-field">
          <label htmlFor="insp-w">WIDTH</label>
          <input
            id="insp-w"
            type="number"
            data-testid="inspector-input-w"
            value={draftW}
            onChange={(e) => {
              setDraftW(e.target.value);
              setIsDirty(true);
            }}
          />
        </div>
        <div className="void-spatial-field">
          <label htmlFor="insp-h">HEIGHT</label>
          <input
            id="insp-h"
            type="number"
            data-testid="inspector-input-h"
            value={draftH}
            onChange={(e) => {
              setDraftH(e.target.value);
              setIsDirty(true);
            }}
          />
        </div>
        <div className="void-spatial-field">
          <label htmlFor="insp-rot">ROT°</label>
          <input
            id="insp-rot"
            type="number"
            data-testid="inspector-input-rotation"
            value={draftRot}
            onChange={(e) => {
              setDraftRot(e.target.value);
              setIsDirty(true);
            }}
          />
        </div>
        <div className="void-spatial-field">
          <label htmlFor="insp-z">Z-INDEX</label>
          <input
            id="insp-z"
            type="number"
            data-testid="inspector-input-z"
            value={draftZ}
            onChange={(e) => {
              setDraftZ(e.target.value);
              setIsDirty(true);
            }}
          />
        </div>
      </div>

      <div className="void-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'html'}
          className={`void-tab ${activeTab === 'html' ? 'active' : ''}`}
          data-testid="tab-html"
          onClick={() => setActiveTab('html')}
        >
          <span>HTML</span>
          <span className="void-tab-count">{draftHtml.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'css'}
          className={`void-tab ${activeTab === 'css' ? 'active' : ''}`}
          data-testid="tab-css"
          onClick={() => setActiveTab('css')}
        >
          <span>CSS</span>
          <span className="void-tab-count">{draftCss.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'javascript'}
          className={`void-tab ${activeTab === 'javascript' ? 'active' : ''}`}
          data-testid="tab-javascript"
          onClick={() => setActiveTab('javascript')}
        >
          <span>JS</span>
          <span className="void-tab-count">{draftJs.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'history'}
          className={`void-tab ${activeTab === 'history' ? 'active' : ''}`}
          data-testid="tab-history"
          onClick={() => setActiveTab('history')}
        >
          <span>HISTORY</span>
          <span className="void-tab-count">r{object.revision}</span>
        </button>
      </div>

      <div className="void-editor-container">
        {activeTab === 'html' && (
          <CodeEditorSurface
            language="html"
            value={draftHtml}
            onChange={(val) => {
              setDraftHtml(val);
              setIsDirty(true);
              setSaveState('idle');
            }}
            onRunShortcut={() => void handleRunAndCommit()}
          />
        )}

        {activeTab === 'css' && (
          <CodeEditorSurface
            language="css"
            value={draftCss}
            onChange={(val) => {
              setDraftCss(val);
              setIsDirty(true);
              setSaveState('idle');
            }}
            onRunShortcut={() => void handleRunAndCommit()}
          />
        )}

        {activeTab === 'javascript' && (
          <CodeEditorSurface
            language="javascript"
            value={draftJs}
            onChange={(val) => {
              setDraftJs(val);
              setIsDirty(true);
              setSaveState('idle');
            }}
            onRunShortcut={() => void handleRunAndCommit()}
          />
        )}

        {activeTab === 'history' && (
          <div className="void-history-pane" data-testid="history-pane">
            <div className="void-history-notice">
              OBJECT ARCHAEOLOGY — inspect previous revisions and copy source manually into a new object.
            </div>
            {historyError && <div className="void-history-error">{historyError}</div>}
            <div className="void-history-split">
              <div className="void-revision-list" data-testid="revision-list">
                {historyLoading && revisions.length === 0 ? (
                  <div className="void-history-empty">loading revisions...</div>
                ) : (
                  revisions.map((rev) => {
                    const verb = rev.eventType === 'created' ? 'created' : 'modified';
                    return (
                      <button
                        key={rev.revision}
                        type="button"
                        className={`void-revision-row ${selectedRevisionNum === rev.revision ? 'active' : ''}`}
                        data-testid={`revision-item-${rev.revision}`}
                        onClick={() => void handleSelectRevision(rev.revision)}
                      >
                        <div className="void-revision-row-top">
                          <span className="void-revision-num">r{rev.revision}</span>
                          <span className={`void-event-badge ${rev.eventType}`}>{rev.eventType}</span>
                        </div>
                        <div className="void-revision-row-time">
                          {verb} {formatRelativeTime(rev.createdAt, nowMs)}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="void-revision-detail" data-testid="revision-detail">
                {selectedRevisionDetail ? (
                  <>
                    <div className="void-revision-actions">
                      <span className="void-revision-summary">
                        r{selectedRevisionDetail.revision} · {selectedRevisionDetail.eventType}{' '}
                        {formatRelativeTime(selectedRevisionDetail.createdAt, nowMs)}
                      </span>
                      <div className="void-revision-btn-group">
                        <button
                          type="button"
                          className="void-btn"
                          data-testid="history-copy-clipboard-btn"
                          onClick={() =>
                            void handleCopySourceClipboard({
                              html: selectedRevisionDetail.html,
                              css: selectedRevisionDetail.css,
                              javascript: selectedRevisionDetail.javascript
                            })
                          }
                        >
                          copy revision source
                        </button>
                        <button
                          type="button"
                          className="void-btn primary"
                          data-testid="history-spawn-copy-btn"
                          onClick={() => void handleSpawnFromHistoricalRevision(selectedRevisionDetail)}
                        >
                          create new object from r{selectedRevisionDetail.revision}
                        </button>
                      </div>
                    </div>

                    <div className="void-revision-code-scroll">
                      <div className="void-revision-code-block">
                        <header>
                          <span>HTML</span>
                          <span className="void-revision-bytes">{selectedRevisionDetail.htmlBytes} bytes</span>
                        </header>
                        <pre data-testid="history-detail-html">{selectedRevisionDetail.html || '/* empty */'}</pre>
                      </div>
                      <div className="void-revision-code-block">
                        <header>
                          <span>CSS</span>
                          <span className="void-revision-bytes">{selectedRevisionDetail.cssBytes} bytes</span>
                        </header>
                        <pre data-testid="history-detail-css">{selectedRevisionDetail.css || '/* empty */'}</pre>
                      </div>
                      <div className="void-revision-code-block">
                        <header>
                          <span>JS</span>
                          <span className="void-revision-bytes">{selectedRevisionDetail.jsBytes} bytes</span>
                        </header>
                        <pre data-testid="history-detail-js">{selectedRevisionDetail.javascript || '// empty'}</pre>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="void-history-empty">select a revision to inspect source code</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {diagnostics.length > 0 && (
        <div className="void-diagnostics" data-testid="inspector-diagnostics">
          <div className="void-diagnostics-header">
            <span>SANDBOX DIAGNOSTICS ({diagnostics.length})</span>
            <button
              type="button"
              className="void-mini-btn"
              onClick={() => onClearDiagnostics(object.id)}
            >
              clear
            </button>
          </div>
          {diagnostics.map((d, idx) => (
            <div
              key={`${d.timestamp}-${idx}`}
              className={`void-diag-item ${d.type !== 'console_log' ? 'error' : ''}`}
              data-testid="inspector-diag-entry"
            >
              <span className="void-diag-type">{d.type}</span>
              <span>
                {d.message}
                {d.line ? ` (line ${d.line})` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="void-inspector-footer">
        <div
          className={`void-save-status ${isDirty ? 'dirty' : ''} ${saveState === 'error' ? 'error' : ''}`}
          data-testid="inspector-save-status"
        >
          {saveState === 'error' && saveError
            ? `error: ${saveError}`
            : copiedFeedback
              ? copiedFeedback
              : saveState === 'saving'
                ? 'saving mutation to world...'
                : isDirty
                  ? 'unsaved local edits — press run / commit'
                  : `synced with world (r${object.revision})`}
        </div>
        <div className="void-footer-coords">
          {object.width}×{object.height} @ ({Math.round(object.x)}, {Math.round(object.y)})
        </div>
      </div>
    </aside>
  );
}
