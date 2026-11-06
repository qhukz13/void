export const WORLD_MIN_COORD = -10_000_000;
export const WORLD_MAX_COORD = 10_000_000;

export const CHUNK_SIZE = 2048;

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 4.0;
export const DEFAULT_ZOOM = 1.0;

export const DEFAULT_OBJECT_WIDTH = 360;
export const DEFAULT_OBJECT_HEIGHT = 260;
export const MIN_OBJECT_WIDTH = 64;
export const MAX_OBJECT_WIDTH = 4096;
export const MIN_OBJECT_HEIGHT = 48;
export const MAX_OBJECT_HEIGHT = 4096;

export const MIN_ROTATION = -360;
export const MAX_ROTATION = 360;

export const MIN_Z_INDEX = -10000;
export const MAX_Z_INDEX = 10000;

export const DEFAULT_MAX_HTML_BYTES = 65536;
export const DEFAULT_MAX_CSS_BYTES = 65536;
export const DEFAULT_MAX_JS_BYTES = 65536;

export const MAX_ACTIVE_SANDBOXES = 36;
export const SANDBOX_EXECUTION_MIN_ZOOM = 0.18;
export const SANDBOX_LOOP_TIME_BUDGET_MS = 500;
export const SANDBOX_MAX_LOOP_ITERATIONS = 1_000_000;
export const SANDBOX_MAX_DOM_NODES = 1500;
export const SANDBOX_MAX_ACTIVE_TIMERS = 64;
export const SANDBOX_MAX_MESSAGES_PER_SEC = 30;
export const SANDBOX_MAX_MESSAGE_BYTES = 4096;

export const DEFAULT_NEW_OBJECT_HTML = `<div class="void-node">
  <h1>SIGNAL</h1>
  <p>mutable artifact in the void</p>
  <button id="pulse">trigger</button>
</div>`;

export const DEFAULT_NEW_OBJECT_CSS = `body {
  margin: 0;
  height: 100vh;
  display: grid;
  place-items: center;
  background: #0a0c10;
  color: #e6eaef;
  font-family: ui-monospace, monospace;
}
.void-node {
  text-align: center;
  padding: 1rem;
  border: 1px solid #262c36;
}
h1 {
  font-size: 1.25rem;
  letter-spacing: 0.12em;
  margin: 0 0 0.5rem;
}
p {
  font-size: 0.75rem;
  color: #7d8794;
  margin: 0 0 0.85rem;
}
button {
  background: #161a20;
  color: #c8a24e;
  border: 1px solid #c8a24e;
  padding: 0.35rem 0.75rem;
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}`;

export const DEFAULT_NEW_OBJECT_JS = `const btn = document.getElementById('pulse');
let count = 0;
if (btn) {
  btn.addEventListener('click', () => {
    count += 1;
    btn.textContent = 'pulse #' + count;
  });
}`;
