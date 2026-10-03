// Client for the OpusVita REST API (server.js). Every request goes over HTTP as JSON.
const api = (() => {
  async function request(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('No connection to the server. Check your internet and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }
  return {
    dashboard: () => request('GET', '/api/dashboard'),
    health: days => request('GET', `/api/health?days=${days}`),
    sync: () => request('POST', '/api/device/sync'),
    setDevice: connected => request('PUT', '/api/device', { connected }),
    me: () => request('GET', '/api/me'),
    updateMe: data => request('PUT', '/api/me', data),
    updateSettings: data => request('PUT', '/api/settings', data),
    psychologists: () => request('GET', '/api/psychologists'),
    availability: (id, exclude) => request('GET', `/api/psychologists/${id}/availability${exclude ? `?exclude=${exclude}` : ''}`),
    checkins: () => request('GET', '/api/checkins'),
    submitCheckin: data => request('POST', '/api/checkins', data),
    deleteCheckins: () => request('DELETE', '/api/checkins'),
    bookings: () => request('GET', '/api/bookings'),
    book: data => request('POST', '/api/bookings', data),
    updateBooking: (id, data) => request('PATCH', `/api/bookings/${id}`, data),
    reset: () => request('POST', '/api/reset'),
  };
})();
