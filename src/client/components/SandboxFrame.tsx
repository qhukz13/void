import React, { useEffect, useMemo, useRef } from 'react';
import { buildSandboxSrcDoc } from '../../shared/sandbox-builder.js';
import type { SandboxDiagnostic, VoidObject } from '../../shared/types.js';

interface SandboxFrameProps {
  object: VoidObject;
  active: boolean;
  cameraZoom: number;
  onDiagnostic: (diag: SandboxDiagnostic) => void;
  onClearDiagnostics: (objectId: string) => void;
}

export function SandboxFrame({
  object,
  active,
  cameraZoom,
  onDiagnostic,
  onClearDiagnostics
}: SandboxFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const zoomRef = useRef<number>(cameraZoom);
  zoomRef.current = cameraZoom;

  const srcDoc = useMemo(() => {
    if (!active) return '';
    return buildSandboxSrcDoc({
      objectId: object.id,
      revision: object.revision,
      html: object.html,
      css: object.css,
      javascript: object.javascript,
      zoom: zoomRef.current
    });
  }, [active, object.id, object.revision, object.html, object.css, object.javascript]);

  // Synchronize native vector zoom inside the sandboxed iframe without reloading or bitmap-scaling
  useEffect(() => {
    if (!active) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          source: 'THE_VOID_HOST',
          type: 'SET_ZOOM',
          zoom: cameraZoom
        },
        '*'
      );
    } catch (_) {}
  }, [active, cameraZoom]);

  useEffect(() => {
    if (!active) return;
    onClearDiagnostics(object.id);

    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== 'object' || data.source !== 'THE_VOID_SANDBOX') {
        return;
      }
      if (data.objectId !== object.id) {
        return;
      }
      if (data.type === 'ready') {
        return;
      }
      const allowedTypes = new Set([
        'syntax_error',
        'runtime_error',
        'timeout_error',
        'dom_limit',
        'resource_limit',
        'console_error',
        'console_log'
      ]);
      if (!allowedTypes.has(data.type)) {
        return;
      }

      onDiagnostic({
        objectId: object.id,
        revision: Number(data.revision) || object.revision,
        type: data.type,
        message: String(data.message || 'Sandbox diagnostic').slice(0, 500),
        line: typeof data.line === 'number' ? data.line : undefined,
        column: typeof data.column === 'number' ? data.column : undefined,
        timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now()
      });
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [active, object.id, object.revision, object.html, object.css, object.javascript, onDiagnostic, onClearDiagnostics]);

  if (!active) {
    return (
      <div className="void-dormant-placeholder" data-testid={`sandbox-dormant-${object.id}`}>
        <div className="void-dormant-badge">[SANDBOX DORMANT // ZOOM IN]</div>
        <div className="void-dormant-meta">
          {object.width}x{object.height} · r{object.revision} · ({Math.round(object.x)}, {Math.round(object.y)})
        </div>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      key={`${object.id}:${object.revision}`}
      className="void-sandbox-iframe"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      title={`void-object-${object.id}`}
      data-testid={`sandbox-iframe-${object.id}`}
      onLoad={() => {
        try {
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: 'THE_VOID_HOST',
              type: 'SET_ZOOM',
              zoom: zoomRef.current
            },
            '*'
          );
        } catch (_) {}
      }}
    />
  );
}
