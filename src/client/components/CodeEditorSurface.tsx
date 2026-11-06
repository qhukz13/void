import React, { useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// Configure Monaco to load directly from the local bundle without external CDN dependency
loader.config({ monaco });

interface CodeEditorSurfaceProps {
  language: 'html' | 'css' | 'javascript';
  value: string;
  onChange: (nextValue: string) => void;
  onRunShortcut: () => void;
}

export function CodeEditorSurface({
  language,
  value,
  onChange,
  onRunShortcut
}: CodeEditorSurfaceProps) {
  const [useDirectBuffer, setUseDirectBuffer] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's')) {
      e.preventDefault();
      onRunShortcut();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = value.slice(0, start) + '  ' + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div className="void-code-surface">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          background: '#090b0f',
          borderBottom: '1px solid var(--border-hairline)',
          fontSize: '10px',
          color: 'var(--text-muted)'
        }}
      >
        <span>
          {language.toUpperCase()} · {value.length} chars · Ctrl+Enter to run & commit
        </span>
        <button
          type="button"
          className="void-mini-btn"
          data-testid="toggle-editor-mode-btn"
          onClick={() => setUseDirectBuffer((prev) => !prev)}
        >
          {useDirectBuffer ? 'monaco view' : 'raw buffer'}
        </button>
      </div>

      {!useDirectBuffer && (
        <div style={{ flex: 1, minHeight: '180px', position: 'relative' }}>
          <Editor
            height="100%"
            language={language}
            theme="vs-dark"
            value={value}
            onChange={(val) => onChange(val ?? '')}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 8, bottom: 8 }
            }}
            onMount={(editor, monacoInstance) => {
              editor.addCommand(
                monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter,
                () => onRunShortcut()
              );
              editor.addCommand(
                monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
                () => onRunShortcut()
              );
            }}
          />
        </div>
      )}

      <div
        style={{
          height: useDirectBuffer ? '100%' : '96px',
          flex: useDirectBuffer ? 1 : '0 0 96px',
          borderTop: useDirectBuffer ? 'none' : '1px solid var(--border-hairline)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {!useDirectBuffer && (
          <div
            style={{
              padding: '2px 10px',
              background: '#0a0c10',
              color: 'var(--text-muted)',
              fontSize: '10px',
              borderBottom: '1px solid var(--border-hairline)'
            }}
          >
            direct source buffer ({language})
          </div>
        )}
        <textarea
          className="void-code-fallback-textarea"
          data-testid={`code-editor-${language}`}
          aria-label={`${language} source code`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
      </div>
    </div>
  );
}
