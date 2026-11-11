export const WORLD_MIN_COORD = -1_000_000_000_000;
export const WORLD_MAX_COORD = 1_000_000_000_000;

export const CHUNK_SIZE = 2048;

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 8.0;
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

export const DEFAULT_NEW_OBJECT_HTML = `<div class="raw-node">
  <div class="bar">[NODE // UNOWNED]</div>
  <h1>RAW SIGNAL</h1>
  <hr />
  <p>no accounts. no rules. anyone can edit or destroy this.</p>
  <button id="pulse">PING [0]</button>
</div>`;

export const DEFAULT_NEW_OBJECT_CSS = `body {
  margin: 0;
  padding: 10px;
  height: 100%;
  display: grid;
  place-items: center;
  background: #000000;
  color: #f0f0f0;
  font-family: 'Courier New', Courier, monospace;
}
.raw-node {
  width: 100%;
  padding: 10px;
  background: #080808;
  border: 1px solid #444444;
  box-shadow: 3px 3px 0 #1b1b1b;
}
.bar {
  font-size: 11px;
  color: #00ff66;
  margin-bottom: 6px;
}
h1 {
  font-size: 20px;
  margin: 0 0 6px;
  color: #ffffff;
  letter-spacing: 1px;
}
hr {
  border: 0;
  border-top: 1px dashed #444444;
  margin: 6px 0;
}
p {
  font-size: 12px;
  color: #b0b0b0;
  margin: 0 0 10px;
}
button {
  background: #141414;
  color: #ffb000;
  border: 1px solid #ffb000;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 12px;
  font-weight: bold;
  cursor: pointer;
}
button:hover {
  background: #ffb000;
  color: #000000;
}`;

export const DEFAULT_NEW_OBJECT_JS = `const btn = document.getElementById('pulse');
let count = 0;
if (btn) {
  btn.addEventListener('click', () => {
    count += 1;
    btn.textContent = 'PING [' + count + ']';
  });
}`;
