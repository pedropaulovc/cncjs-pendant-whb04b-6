// Timers hosted in a dedicated Worker. Chrome runs window timers in a hidden
// tab at most once a second, and chained ones once a minute after five minutes
// hidden; dedicated-worker timers are not throttled that way. The worker comes
// from an inline Blob, so it needs no extra file under CNCjs's --mount path and
// works in a same-origin (sandboxed) iframe. If the Worker cannot start (for
// example a CSP without `worker-src blob:`), pending and later timers move to
// window timers and the fallback is logged once.

// Timer kinds: 'once' fires one time; 'repeat' fires every `ms` until canceled.
const SOURCE = `const handles = new Map();
onmessage = ({ data: { op, id, ms } }) => {
  if (op === 'cancel') { clearTimeout(handles.get(id)); handles.delete(id); return; }
  if (op === 'once') { handles.set(id, setTimeout(() => { handles.delete(id); postMessage(id); }, ms)); return; }
  handles.set(id, setInterval(() => postMessage(id), ms));
};`;

function blobWorker() {
  // The URL stays valid for the page's lifetime: revoking it right away can
  // race the worker's script fetch.
  return new Worker(URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' })));
}

// schedule(fn, ms) runs once; repeat(fn, ms) runs every ms; cancel(id) stops
// either. Ids are never reused, so a late worker message for a canceled timer
// is ignored.
export function createWorkerTimers({ createWorker = blobWorker, log = () => {}, now = () => performance.now() } = {}) {
  const entries = new Map();
  let nextId = 0;
  let worker = null;
  let mode = 'worker';

  const fire = (id) => {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.kind === 'once') entries.delete(id);
    entry.due = now() + entry.ms;
    entry.fn();
  };
  const startWindow = (id, entry, delay) => {
    if (entry.kind === 'once') { entry.handle = setTimeout(() => fire(id), delay); return; }
    entry.handle = setInterval(() => fire(id), entry.ms);
  };
  const fallBack = (reason) => {
    if (mode === 'window') return;
    mode = 'window';
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    log(`Background timers unavailable (${reason}); using window timers, which Chrome slows to once a second or less while this tab is hidden.`);
    for (const [id, entry] of entries) startWindow(id, entry, Math.max(0, entry.due - now()));
  };

  try {
    worker = createWorker();
    worker.onmessage = (e) => fire(e.data);
    worker.onerror = (e) => { e?.preventDefault?.(); fallBack(e?.message || 'worker error'); };
  } catch (error) {
    fallBack(String(error?.message || error));
  }

  const add = (fn, ms, kind) => {
    const id = ++nextId;
    const entry = { fn, ms, kind, due: now() + ms, handle: null };
    entries.set(id, entry);
    if (mode === 'window') { startWindow(id, entry, ms); return id; }
    worker.postMessage({ op: kind, id, ms });
    return id;
  };
  return {
    get mode() { return mode; },
    schedule: (fn, ms) => add(fn, ms, 'once'),
    repeat: (fn, ms) => add(fn, ms, 'repeat'),
    cancel(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      if (mode === 'window') { clearTimeout(entry.handle); return; }
      worker.postMessage({ op: 'cancel', id });
    },
  };
}
