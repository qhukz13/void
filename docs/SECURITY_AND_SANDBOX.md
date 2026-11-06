# Security & Sandbox Isolation Documentation — THE VOID

## 1. Threat Model

Every byte of HTML, CSS, and JavaScript stored in THE VOID is untrusted and potentially hostile. Adversaries may attempt to:
1. Execute XSS in the parent World Engine context or read parent DOM/state.
2. Escape the iframe or navigate the top-level window (`window.top.location`).
3. Freeze visitors' browsers via synchronous infinite loops (`while(true){}`, `for(;;){}`), infinite recursion, runaway timers, or DOM node floods.
4. Probe internal/private networks (SSRF / local loopback access) or exfiltrate visitor data via `fetch`, `XMLHttpRequest`, `WebSocket`, or external resource tags.
5. Flood the backend via oversized payloads, rapid object creation, WebSocket message floods, SQL injection, or prototype pollution.

---

## 2. Sandbox Architecture (`src/shared/sandbox-builder.ts` & `src/client/components/SandboxFrame.tsx`)

### 2.1 Opaque Origin Boundary
Each object is rendered inside an `<iframe>` configured with:
```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  srcdoc="..."
></iframe>
```
- **`allow-same-origin` is strictly omitted**: The browser assigns the iframe a unique opaque origin (`window.origin === "null"`).
- Any attempt by user JavaScript to read `window.parent.document`, `window.top.location`, `localStorage`, `sessionStorage`, `indexedDB`, or `document.cookie` throws a native browser `SecurityError`.
- **`allow-top-navigation`, `allow-popups`, `allow-modals`, and `allow-forms` are omitted**: User code cannot redirect the parent page, open popup windows, submit forms, or block the UI thread with `alert()` / `prompt()` / `confirm()` / `print()`.

### 2.2 Inner Content Security Policy (CSP)
Every `srcdoc` document begins with an explicit `<meta http-equiv="Content-Security-Policy">`:
```text
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
font-src data:;
media-src data: blob:;
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```
- **`connect-src 'none'`**: Completely disables `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `navigator.sendBeacon()` inside user code. User creations cannot probe `127.0.0.1`, private RFC1918 networks, cloud metadata endpoints, or external command-and-control servers.
- **Breakout Escaping**: User CSS and JavaScript are sanitized against `</style>` and `</script>` tag injection before embedding into `srcdoc`.

### 2.3 Failure Isolation & Resource Guards
- **Synchronous Loop Guard (`__voidLoopGuard`)**: Before execution, `instrumentUserJavaScript` scans user JavaScript (skipping string/template literals and comments) and injects `__voidLoopGuard()` into `while`, `for`, and `do...while` loops. If a loop exceeds `250ms` or `250,000` iterations, `__voidLoopGuard()` halts the sandbox, sends a `timeout_error` diagnostic to the parent, and throws a `RangeError`.
- **Pre-execution Syntax Validation**: Syntax errors are detected via parser validation and reported immediately as a local `syntax_error` diagnostic.
- **DOM Node Cap (`SANDBOX_MAX_DOM_NODES = 1500`)**: `Node.prototype.appendChild`, `insertBefore`, and `Element.prototype.append` check `document.getElementsByTagName('*').length` and abort execution if an object attempts to create more than `1,500` elements.
- **Timer & RAF Throttling**: `setTimeout`, `setInterval`, and `requestAnimationFrame` are wrapped to enforce a maximum of `32` concurrent active timers, a minimum delay of `16ms`/`20ms`, and a cumulative callback CPU budget of `350ms` per second.
- **Narrow `postMessage` Validation**: The parent `SandboxFrame` only accepts messages where `event.source === iframeRef.current.contentWindow`, `data.source === 'THE_VOID_SANDBOX'`, and `data.objectId === object.id`. Payloads are rate-limited (`30 msg/sec`) and truncated (`<= 4 KB`).

---

## 3. Server & Infrastructure Security

- **Parameterized SQL Everywhere**: All queries in `ObjectRepository` and `migrations.ts` use parameterized placeholders (`$1, $2, ...`).
- **Prototype Pollution Guard**: `hasForbiddenPrototypeKeys` inspects incoming HTTP and WebSocket JSON payloads and rejects any object containing `__proto__`, `constructor`, or `prototype` keys (`400 INVALID_PAYLOAD`).
- **WebSocket Origin Validation**: `/ws` validates the `Origin` header via `isOriginAllowed`. Requests from `Origin: null` (such as sandboxed iframes) or untrusted domains are rejected with WebSocket close code `1008`.
- **Configurable Rate Limiting**: `ActionRateLimiter` enforces per-IP sliding-window limits for creations, mutations, deletions, HTTP requests, and WebSocket messages while imposing **zero cooldown** on ordinary single-object edits or deletions.
- **Restoration Prohibition**: `POST /api/objects/:id/restore`, `/revert`, and `/rollback` explicitly return `403 RESTORATION_FORBIDDEN`.
