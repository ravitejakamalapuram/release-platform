// Scripted fetch double: each call consumes the next expected response and records the request.
export function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request ${init.method} ${url}`);
    if (next.match) next.match(url, init);
    const status = next.status ?? 200;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  fetchImpl.calls = calls;
  fetchImpl.remaining = () => queue.length;
  return fetchImpl;
}

export const googleError = (status, message) => ({ status, body: { error: { code: status, message, status: 'FAILED_PRECONDITION' } } });
