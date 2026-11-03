// Read CNCjs's shared macros and tool settings with the parent widget's session.
export class CncjsMacros {
  constructor({ getToken, fetch = (...args) => globalThis.fetch(...args) } = {}) {
    this.getToken = getToken;
    this.fetch = fetch;
    this.notice = '';
  }

  async request(path, { label = 'CNCjs macros', allowEmpty = false } = {}) {
    const token = this.getToken?.();
    if (typeof token !== 'string' || !token) throw new Error(`${label}: waiting for a session token.`);
    let response;
    try {
      response = await this.fetch(path, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(1000),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'request timed out' : 'request failed';
      throw new Error(`${label}: ${reason}.`, { cause: error });
    }
    if (response.status === 404 && path.startsWith('/api/macros/')) throw new Error('CNCjs macro no longer exists. Refresh the macro list.');
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}.`);
    try {
      if (!allowEmpty) return await response.json();
      const body = await response.text();
      // Native GET /api/tool sends an empty 200 body when the tool store is unset.
      return body === '' ? {} : JSON.parse(body);
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error(`${label}: request timed out.`, { cause: error });
      }
      throw new Error(`${label}: invalid JSON response.`, { cause: error });
    }
  }

  async list() {
    const data = await this.request('/api/macros');
    if (!Array.isArray(data?.records)) throw new Error('CNCjs macros: invalid macro list.');
    const records = [];
    for (const value of data.records) {
      try { records.push(validateRecord(value)); }
      catch { /* Keep valid choices available when CNCjs contains a malformed record. */ }
    }
    const omitted = data.records.length - records.length;
    this.notice = omitted ? `Skipped ${omitted} invalid CNCjs macro ${omitted === 1 ? 'record' : 'records'}.` : '';
    return records;
  }

  async read(id) {
    if (typeof id !== 'string' || !id) throw new Error('Select a saved CNCjs macro.');
    const record = validateRecord(await this.request(`/api/macros/${encodeURIComponent(id)}`));
    if (record.id !== id) throw new Error('CNCjs macros: response does not match the selected macro.');
    return record;
  }

  readToolChangeZ() { return this.readToolNumber('toolChangeZ'); }

  readTouchPlateHeight() { return this.readToolNumber('touchPlateHeight', true); }

  async readToolNumber(key, nonnegative = false) {
    const tool = await this.request('/api/tool', { label: 'CNCjs tool settings', allowEmpty: true });
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('CNCjs tool settings: invalid tool record.');
    if (!Object.hasOwn(tool, key)) return 0;
    const value = tool[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) {
      throw new Error(`CNCjs tool settings: ${key} must be a finite ${nonnegative ? 'nonnegative ' : ''}number of millimetres.`);
    }
    return value;
  }
}

function validateRecord(value) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.content !== 'string') {
    throw new Error('CNCjs macros: invalid macro record.');
  }
  return { id: value.id, name: value.name, content: value.content };
}
