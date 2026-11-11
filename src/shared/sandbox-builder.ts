import {
  SANDBOX_LOOP_TIME_BUDGET_MS,
  SANDBOX_MAX_ACTIVE_TIMERS,
  SANDBOX_MAX_DOM_NODES,
  SANDBOX_MAX_LOOP_ITERATIONS,
  SANDBOX_MAX_MESSAGE_BYTES,
  SANDBOX_MAX_MESSAGES_PER_SEC
} from './constants.js';

/**
 * Instruments synchronous loops (`while`, `for`, `do...while`) in user JavaScript
 * so that infinite loops (`while(true){}`, `for(;;){}`) throw a RangeError
 * after exceeding SANDBOX_LOOP_TIME_BUDGET_MS or SANDBOX_MAX_LOOP_ITERATIONS
 * instead of freezing the browser thread.
 *
 * Also handles braceless loops (`while (true);`, `for (;;);`) by inserting
 * `__voidLoopGuard()` directly inside the loop condition or body.
 */
export function instrumentUserJavaScript(source: string): {
  code: string;
  syntaxError: { message: string; line?: number } | null;
} {
  if (!source || source.trim() === '') {
    return { code: '', syntaxError: null };
  }

  // First check if the user code has a syntax error by parsing with Function constructor
  // (without executing it!). Note: allow top-level await or normal script bodies.
  try {
    new Function(source);
  } catch (err: unknown) {
    try {
      // Also check async function wrapper in case top-level await was used
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      new AsyncFunction(source);
    } catch {
      const message = err instanceof Error ? err.message : String(err);
      return {
        code: source,
        syntaxError: { message }
      };
    }
  }

  try {
    const transformed = injectLoopGuards(source);
    // Verify the transformed code is still syntactically valid
    new Function(transformed);
    return { code: transformed, syntaxError: null };
  } catch {
    // Fallback to original source if an exotic JS construct prevented transformation
    return { code: source, syntaxError: null };
  }
}

/**
 * Lexical scanner that injects `__voidLoopGuard()` into `while (...)`, `for (...)`,
 * and `do { ... }` loops while ignoring strings, template literals, and comments.
 */
function injectLoopGuards(source: string): string {
  // 1. Replace `while (<cond>)` with `while (__voidLoopGuard() && (<cond>))`
  // 2. Replace `for (<init>; <cond>; <step>)` where <cond> may be empty:
  //    `for (<init>; __voidLoopGuard() && (<cond_or_true>); <step>)`
  // This approach works for BOTH braced `{ ... }` and braceless `;` loops!
  let out = '';
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end === -1) {
        out += source.slice(i);
        break;
      }
      out += source.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        out += source.slice(i);
        break;
      }
      out += source.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Single or double quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < len) {
        const c = source[i];
        out += c;
        i++;
        if (c === '\\' && i < len) {
          out += source[i];
          i++;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }

    // Template literal
    if (ch === '`') {
      out += ch;
      i++;
      while (i < len) {
        const c = source[i];
        out += c;
        i++;
        if (c === '\\' && i < len) {
          out += source[i];
          i++;
        } else if (c === '`') {
          break;
        }
      }
      continue;
    }

    // Check for identifier boundary
    const prevCh = i > 0 ? source[i - 1] : '';
    const isStartBoundary = !/[a-zA-Z0-9_$]/.test(prevCh);

    if (isStartBoundary && source.startsWith('while', i) && !/[a-zA-Z0-9_$]/.test(source[i + 5] || '')) {
      // Scan optional whitespace to '('
      let j = i + 5;
      while (j < len && /\s/.test(source[j])) j++;
      if (source[j] === '(') {
        const closeParen = findMatchingParen(source, j);
        if (closeParen !== -1) {
          const cond = source.slice(j + 1, closeParen).trim();
          out += `while (__voidLoopGuard() && (${cond.length > 0 ? cond : 'true'}))`;
          i = closeParen + 1;
          continue;
        }
      }
    }

    if (isStartBoundary && source.startsWith('for', i) && !/[a-zA-Z0-9_$]/.test(source[i + 3] || '')) {
      let j = i + 3;
      while (j < len && /\s/.test(source[j])) j++;
      // Handle `for (` (not `for await`)
      if (source[j] === '(') {
        const closeParen = findMatchingParen(source, j);
        if (closeParen !== -1) {
          const header = source.slice(j + 1, closeParen);
          const semicolons = splitTopLevelSemicolons(header);
          if (semicolons !== null && semicolons.length === 3) {
            const [initPart, condPart, stepPart] = semicolons;
            const trimmedCond = condPart.trim();
            const guardedCond =
              trimmedCond.length > 0
                ? `__voidLoopGuard() && (${trimmedCond})`
                : `__voidLoopGuard()`;
            out += `for (${initPart}; ${guardedCond}; ${stepPart})`;
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function findMatchingParen(source: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  const len = source.length;
  while (i < len) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < len) {
        if (source[i] === '\\') {
          i += 2;
        } else if (source[i] === q) {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function splitTopLevelSemicolons(header: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let lastStart = 0;
  let i = 0;
  const len = header.length;

  while (i < len) {
    const c = header[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < len) {
        if (header[i] === '\\') i += 2;
        else if (header[i] === q) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) {
      parts.push(header.slice(lastStart, i));
      lastStart = i + 1;
    }
    i++;
  }
  parts.push(header.slice(lastStart));
  return parts.length === 3 ? parts : null;
}

function escapeScriptCloseTag(str: string): string {
  return str.replace(/<\/script/gi, '<\\/script');
}

function escapeStyleCloseTag(str: string): string {
  return str.replace(/<\/style/gi, '<\\/style');
}

/**
 * Builds the complete isolated `srcdoc` HTML payload for an untrusted VoidObject.
 *
 * Security invariants enforced:
 * 1. Rendered inside `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`
 *    (NO `allow-same-origin`, NO `allow-top-navigation`, NO `allow-popups`, NO `allow-modals`, NO `allow-forms`).
 * 2. Strict Content-Security-Policy meta tag inside the document:
 *    `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`
 * 3. Synchronous loop guard (`__voidLoopGuard`) halts infinite `while`/`for` loops after 250ms or 250k iterations.
 * 4. DOM element count guard halts excessive DOM creation (>1500 nodes).
 * 5. Timer and RAF guard caps active timers (32) and cumulative timer CPU time.
 * 6. Narrow postMessage channel back to the World Engine tagged with `(objectId, revision)` and rate-limited.
 */
export function buildSandboxSrcDoc(params: {
  objectId: string;
  revision: number;
  html: string;
  css: string;
  javascript: string;
  zoom?: number;
}): string {
  const { objectId, revision, html, css, javascript, zoom } = params;
  const initialZoom = typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const instrumented = instrumentUserJavaScript(javascript);
  const safeCss = escapeStyleCloseTag(css);
  const safeUserJs = escapeScriptCloseTag(instrumented.code);
  const preSyntaxErrorJson = JSON.stringify(instrumented.syntaxError);
  const safeObjectIdJson = JSON.stringify(objectId);

  return `<!DOCTYPE html>
<html style="zoom: ${initialZoom};">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';" />
<style>
  :root {
    color-scheme: dark;
  }
  *, *::before, *::after { box-sizing: border-box; }
  @keyframes __void-blink { 50% { visibility: hidden; } }
  blink, .blink { animation: __void-blink 1s step-end infinite; }
  :where(html, body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    color: #f0f0f0;
    font-family: 'Courier New', Courier, monospace;
    font-size: 13px;
    line-height: 1.35;
    text-rendering: geometricPrecision;
  }
  :where(body) {
    padding: 8px;
    overflow: auto;
  }
  :where(h1, h2, h3, h4, h5, h6) {
    margin: 0 0 6px;
    color: #ffffff;
    font-weight: bold;
    line-height: 1.15;
  }
  :where(h1) { font-size: 20px; }
  :where(h2) { font-size: 16px; }
  :where(h3) { font-size: 14px; color: #ffb000; }
  :where(p, ul, ol, dl, blockquote, pre, table, fieldset) {
    margin: 0 0 8px;
  }
  :where(a) {
    color: #00ffff;
    text-decoration: underline;
  }
  :where(a:visited) { color: #ff66ff; }
  :where(a:hover, a:active) {
    background: #ffff00;
    color: #000000;
  }
  :where(hr) {
    border: 0;
    border-top: 1px dashed #555555;
    margin: 8px 0;
  }
  :where(code, pre, samp, kbd) {
    font-family: 'Courier New', Courier, monospace;
  }
  :where(code) {
    color: #00ff66;
    background: #0a0a0a;
    padding: 0 3px;
    border: 1px solid #333333;
  }
  :where(pre) {
    background: #050505;
    color: #00ff66;
    border: 1px solid #333333;
    padding: 6px;
    overflow-x: auto;
  }
  :where(blockquote) {
    border-left: 2px solid #ffb000;
    padding-left: 8px;
    color: #cccccc;
  }
  :where(button, input[type="button"], input[type="submit"], input[type="reset"]) {
    background: #1a1a1a;
    color: #f0f0f0;
    border: 2px outset #666666;
    padding: 2px 8px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  :where(button:active, input[type="button"]:active, input[type="submit"]:active, input[type="reset"]:active) {
    border-style: inset;
  }
  :where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select) {
    background: #000000;
    color: #00ff66;
    border: 1px solid #666666;
    padding: 2px 5px;
    font-family: inherit;
    font-size: 12px;
  }
  :where(input:focus, textarea:focus, select:focus, button:focus-visible) {
    outline: 1px dotted #ffff00;
  }
  :where(table) {
    border-collapse: collapse;
    width: 100%;
  }
  :where(th, td) {
    border: 1px solid #555555;
    padding: 3px 6px;
    text-align: left;
  }
  :where(th) {
    background: #141414;
    color: #ffb000;
  }
  :where(fieldset) {
    border: 1px solid #555555;
    padding: 6px 8px;
  }
  :where(legend) {
    color: #ffb000;
    padding: 0 4px;
  }
  :where(img, canvas, svg, video) {
    max-width: 100%;
    image-rendering: pixelated;
  }
</style>
<style id="void-user-style">${safeCss}</style>
</head>
<body>
${html}
<script>
(function() {
  const OBJECT_ID = ${safeObjectIdJson};
  const REVISION = ${Number(revision) || 1};
  const LOOP_BUDGET_MS = ${SANDBOX_LOOP_TIME_BUDGET_MS};
  const MAX_ITERATIONS = ${SANDBOX_MAX_LOOP_ITERATIONS};
  const MAX_DOM_NODES = ${SANDBOX_MAX_DOM_NODES};
  const MAX_TIMERS = ${SANDBOX_MAX_ACTIVE_TIMERS};
  const MAX_MSG_PER_SEC = ${SANDBOX_MAX_MESSAGES_PER_SEC};
  const MAX_MSG_BYTES = ${SANDBOX_MAX_MESSAGE_BYTES};

  let msgCountWindowStart = Date.now();
  let msgCount = 0;
  let halted = false;

  const nativePostMessage = window.parent ? window.parent.postMessage.bind(window.parent) : null;

  window.addEventListener('message', function(ev) {
    try {
      const d = ev && ev.data;
      if (d && d.source === 'THE_VOID_HOST' && d.type === 'SET_ZOOM' && typeof d.zoom === 'number' && d.zoom > 0) {
        document.documentElement.style.zoom = String(d.zoom);
      }
    } catch (_) {}
  });

  function sendToEngine(type, message, extra) {
    if (!nativePostMessage) return;
    const now = Date.now();
    if (now - msgCountWindowStart > 1000) {
      msgCountWindowStart = now;
      msgCount = 0;
    }
    msgCount += 1;
    if (msgCount > MAX_MSG_PER_SEC) return;

    const cleanMessage = String(message || '').slice(0, 1024);
    const payload = Object.assign({
      source: 'THE_VOID_SANDBOX',
      objectId: OBJECT_ID,
      revision: REVISION,
      type: type,
      message: cleanMessage,
      timestamp: now
    }, extra || {});

    try {
      const serialized = JSON.stringify(payload);
      if (serialized.length <= MAX_MSG_BYTES) {
        nativePostMessage(payload, '*');
      }
    } catch (_) {}
  }

  // Lock down modal dialogs that could block browser UI
  window.alert = function(msg) { sendToEngine('console_log', '[alert] ' + String(msg)); };
  window.confirm = function() { return false; };
  window.prompt = function() { return null; };
  window.print = function() {};
  window.open = function() { return null; };

  // Per-turn synchronous loop budget tracker.
  // Automatically resets at the end of every synchronous event-loop turn (script load,
  // keydown, click, setInterval, requestAnimationFrame, Promise microtask, etc.)
  // while still catching any single synchronous turn stuck in while(true){} or for(;;){}.
  const nativeQueueMicrotask = typeof window.queueMicrotask === 'function'
    ? window.queueMicrotask.bind(window)
    : function(cb) { Promise.resolve().then(cb); };

  let turnActive = false;
  let loopStartMs = 0;
  let lastCheckMs = 0;
  let loopIterations = 0;

  function resetLoopBudget() {
    const now = performance.now();
    loopStartMs = now;
    lastCheckMs = now;
    loopIterations = 0;
  }

  Object.defineProperty(window, '__voidResetLoopBudget', {
    value: resetLoopBudget,
    writable: false,
    configurable: false
  });

  Object.defineProperty(window, '__voidLoopGuard', {
    value: function() {
      if (!turnActive) {
        turnActive = true;
        resetLoopBudget();
        nativeQueueMicrotask(function() {
          turnActive = false;
          loopIterations = 0;
        });
      }
      loopIterations += 1;
      if ((loopIterations & 1023) === 0) {
        const now = performance.now();
        // If more than 25ms elapsed since the previous check, the browser yielded across turns
        if (now - lastCheckMs > 25) {
          loopStartMs = now;
          loopIterations = 0;
        }
        lastCheckMs = now;
        const elapsed = now - loopStartMs;
        if (elapsed > LOOP_BUDGET_MS || loopIterations > MAX_ITERATIONS) {
          turnActive = false;
          loopIterations = 0;
          const errMsg = 'Execution timeout: infinite loop or excessive CPU usage (>' + LOOP_BUDGET_MS + 'ms)';
          sendToEngine('timeout_error', errMsg);
          throw new RangeError(errMsg);
        }
      }
      if (loopIterations > MAX_ITERATIONS) {
        turnActive = false;
        loopIterations = 0;
        const errMsg = 'Execution timeout: loop exceeded ' + MAX_ITERATIONS + ' iterations';
        sendToEngine('timeout_error', errMsg);
        throw new RangeError(errMsg);
      }
      return true;
    },
    writable: false,
    configurable: false
  });

  // DOM node count guard
  function checkDomNodeLimit() {
    if (halted) {
      throw new Error('Sandbox execution halted');
    }
    const count = document.getElementsByTagName('*').length;
    if (count > MAX_DOM_NODES) {
      halted = true;
      const msg = 'DOM limit exceeded: maximum ' + MAX_DOM_NODES + ' elements allowed per object';
      sendToEngine('dom_limit', msg);
      throw new Error(msg);
    }
  }

  const origAppendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function(child) {
    checkDomNodeLimit();
    return origAppendChild.call(this, child);
  };

  const origInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function(newNode, refNode) {
    checkDomNodeLimit();
    return origInsertBefore.call(this, newNode, refNode);
  };

  if (Element.prototype.append) {
    const origAppend = Element.prototype.append;
    Element.prototype.append = function() {
      checkDomNodeLimit();
      return origAppend.apply(this, arguments);
    };
  }

  // Timer & animation frame resource guard
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const origRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  const activeTimers = new Set();
  let timerCpuWindowStart = performance.now();
  let timerCpuUsedMs = 0;

  function clearAllTimers() {
    for (const id of activeTimers) {
      origClearTimeout(id);
      origClearInterval(id);
    }
    activeTimers.clear();
  }

  function runGuardedCallback(fn, args) {
    if (halted || typeof fn !== 'function') return;
    const now = performance.now();
    if (now - timerCpuWindowStart > 1000) {
      timerCpuWindowStart = now;
      timerCpuUsedMs = 0;
    }
    resetLoopBudget();
    const start = performance.now();
    try {
      fn.apply(window, args || []);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      sendToEngine('runtime_error', msg);
    } finally {
      timerCpuUsedMs += (performance.now() - start);
      if (timerCpuUsedMs > 750) {
        halted = true;
        clearAllTimers();
        sendToEngine('resource_limit', 'Timer CPU budget exceeded (>750ms/sec)');
      }
    }
  }

  window.setTimeout = function(fn, delay) {
    if (halted) return 0;
    if (activeTimers.size >= MAX_TIMERS) {
      sendToEngine('resource_limit', 'Maximum concurrent timers (' + MAX_TIMERS + ') exceeded');
      return 0;
    }
    const safeDelay = Math.max(4, Number(delay) || 4);
    const extraArgs = Array.prototype.slice.call(arguments, 2);
    const id = origSetTimeout(function() {
      activeTimers.delete(id);
      runGuardedCallback(fn, extraArgs);
    }, safeDelay);
    activeTimers.add(id);
    return id;
  };

  window.clearTimeout = function(id) {
    activeTimers.delete(id);
    return origClearTimeout(id);
  };

  window.setInterval = function(fn, delay) {
    if (halted) return 0;
    if (activeTimers.size >= MAX_TIMERS) {
      sendToEngine('resource_limit', 'Maximum concurrent timers (' + MAX_TIMERS + ') exceeded');
      return 0;
    }
    const safeDelay = Math.max(8, Number(delay) || 8);
    const extraArgs = Array.prototype.slice.call(arguments, 2);
    const id = origSetInterval(function() {
      if (halted) {
        origClearInterval(id);
        activeTimers.delete(id);
        return;
      }
      runGuardedCallback(fn, extraArgs);
    }, safeDelay);
    activeTimers.add(id);
    return id;
  };

  window.clearInterval = function(id) {
    activeTimers.delete(id);
    return origClearInterval(id);
  };

  if (origRAF) {
    window.requestAnimationFrame = function(cb) {
      if (halted) return 0;
      return origRAF(function(ts) {
        runGuardedCallback(cb, [ts]);
      });
    };
  }

  // Console forwarding
  const origConsoleError = console.error.bind(console);
  console.error = function() {
    origConsoleError.apply(console, arguments);
    const text = Array.prototype.map.call(arguments, function(a) {
      return typeof a === 'object' ? JSON.stringify(a) : String(a);
    }).join(' ');
    sendToEngine('console_error', text);
  };

  // Global error & rejection handlers
  window.addEventListener('error', function(event) {
    const isSyntax = event.error instanceof SyntaxError || /SyntaxError/i.test(event.message || '');
    const isTimeout = event.error instanceof RangeError && /Execution timeout/i.test(event.message || '');
    const diagType = isSyntax ? 'syntax_error' : (isTimeout ? 'timeout_error' : 'runtime_error');
    sendToEngine(diagType, event.message || 'Uncaught error in object script', {
      line: event.lineno,
      column: event.colno
    });
  });

  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason;
    const msg = reason && reason.message ? reason.message : String(reason || 'Unhandled promise rejection');
    sendToEngine('runtime_error', msg);
  });

  // Check initial DOM size
  try {
    checkDomNodeLimit();
  } catch (_) {}

  const preSyntaxError = ${preSyntaxErrorJson};
  if (preSyntaxError) {
    halted = true;
    sendToEngine('syntax_error', 'SyntaxError: ' + preSyntaxError.message);
  } else {
    sendToEngine('ready', 'ok');
  }
})();
</script>
${
  instrumented.syntaxError
    ? ''
    : `<script>
window.__voidResetLoopBudget();
${safeUserJs}
</script>`
}
</body>
</html>`;
}
