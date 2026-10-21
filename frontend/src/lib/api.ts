// Keep authentication and workspace loads bounded so a stalled network request
// cannot leave the application on its loading screen indefinitely.
const REQUEST_TIMEOUT_MS = 30000;
let refresh: Promise<boolean> | null = null;

function requestSignal(signal?: AbortSignal | null) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); },
  };
}

async function boundedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const guard = requestSignal(options.signal);
  try {
    return await fetch(path, { ...options, signal: guard.signal, credentials: 'same-origin', cache: 'no-store' });
  } catch (error) {
    if (guard.timedOut()) throw new Error('The server took too long to respond. Check your connection and try again.');
    if (options.signal?.aborted) throw error;
    if (error instanceof TypeError) throw new Error('Unable to reach StudentHub. Check your internet connection and try again.');
    throw error;
  } finally { guard.dispose(); }
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  let response = await boundedFetch(path, options);
  if (response.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/session' && !options.signal?.aborted) {
    refresh ??= boundedFetch('/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(result => result.ok).catch(() => false).finally(() => { refresh = null; });
    if (await refresh) response = await boundedFetch(path, options);
    if (response.status === 401 && !options.signal?.aborted) window.dispatchEvent(new Event('hub:unauthorized'));
  }
  return response;
}

// API gateways may return an HTML error page instead of JSON. Report a useful
// message rather than a JSON syntax error or a blank application screen.
export async function readApiJson<T = any>(response: Response): Promise<T> {
  // A response can send headers but stall while streaming its body.
  // Bound JSON reading as well as the initial network request.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const raw = await Promise.race([
    response.text(),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('The server response took too long to load. Please retry.')), REQUEST_TIMEOUT_MS);
    }),
  ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
  let value: any;
  try { value = JSON.parse(raw); }
  catch { throw new Error(response.ok ? 'StudentHub returned an invalid response. Please retry.' : `StudentHub is unavailable (HTTP ${response.status}). Please retry.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('StudentHub returned an invalid response. Please retry.');
  return value as T;
}

export function apiErrorMessage(value: any, fallback = 'Unable to complete your request.'): string {
  if (typeof value?.error === 'string' && value.error.trim()) return value.error;
  if (typeof value?.error?.message === 'string' && value.error.message.trim()) return value.error.message;
  if (typeof value?.message === 'string' && value.message.trim()) return value.message;
  return fallback;
}

export async function apiPost<T = any>(path: string, input: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const value = await readApiJson(response);
  if (!response.ok) throw new Error(apiErrorMessage(value, 'Unable to save. Try again.'));
  return value as T;
}
