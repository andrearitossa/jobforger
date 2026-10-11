export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && !path.startsWith('/auth/')) location.href = '/login'
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  return raw ? res : res.json()
}

export const fmtDate = (ts) => (ts ? new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')

export const STATUSES = ['wishlist', 'applied', 'interview', 'offer', 'rejected']

export const DOC_KINDS = { cvs: 'CVs', 'cover-letters': 'Cover letters' }
