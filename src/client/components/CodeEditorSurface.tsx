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
      <div className="void-code-toolbar">
        <div className="void-code-toolbar-meta">
          <span className="void-lang-pill">{language.toUpperCase()}</span>
          <span>·</span>
          <span>{value.length} chars</span>
          <span>·</span>
          <span>Ctrl+Enter to commit</span>
        </div>
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
        <div className="void-monaco-stage">
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
              renderLineHighlight: 'line',
              padding: { top: 10, bottom: 10 }
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

      <div className={`void-buffer-drawer ${useDirectBuffer ? 'is-expanded' : ''}`}>
        {!useDirectBuffer && (
          <div className="void-buffer-header">
            <span>direct source buffer ({language})</span>
            <span>sync active</span>
          </div>
        )}
        <textarea
          className="void-code-fallback-textarea"
          data-testid={`code-editor-${language}`}
          aria-label={`${language} source code`}
          placeholder={`Write ${language.toUpperCase()} source...`}
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
