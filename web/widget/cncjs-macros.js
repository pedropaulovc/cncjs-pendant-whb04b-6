// Read CNCjs's shared macro store using the same session as the parent widget.
export class CncjsMacros {
  constructor({ getToken, fetch = (...args) => globalThis.fetch(...args) } = {}) {
    this.getToken = getToken;
    this.fetch = fetch;
  }

  async request(path) {
    const token = this.getToken?.();
    if (typeof token !== 'string' || !token) throw new Error('CNCjs macros: waiting for a session token.');
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
      throw new Error(`CNCjs macros: ${reason}.`, { cause: error });
    }
    if (response.status === 404) throw new Error('CNCjs macro no longer exists. Refresh the macro list.');
    if (!response.ok) throw new Error(`CNCjs macros: HTTP ${response.status}.`);
    try { return await response.json(); }
    catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error('CNCjs macros: request timed out.', { cause: error });
      }
      throw new Error('CNCjs macros: invalid JSON response.', { cause: error });
    }
  }

  async list() {
    const data = await this.request('/api/macros');
    if (!Array.isArray(data?.records)) throw new Error('CNCjs macros: invalid macro list.');
    return data.records.map(validateRecord);
  }

  async read(id) {
    if (typeof id !== 'string' || !id) throw new Error('Select a saved CNCjs macro.');
    const record = validateRecord(await this.request(`/api/macros/${encodeURIComponent(id)}`));
    if (record.id !== id) throw new Error('CNCjs macros: response does not match the selected macro.');
    return record;
  }
}

function validateRecord(value) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.content !== 'string') {
    throw new Error('CNCjs macros: invalid macro record.');
  }
  return { id: value.id, name: value.name, content: value.content };
}
