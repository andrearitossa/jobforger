import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, fmtDate, STATUSES } from '../api'

function NewApplication({ onCancel }) {
  const [form, setForm] = useState({ job_url: '', company: '', position: '', job_description: '' })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const run = (label, fn) => async (e) => {
    e?.preventDefault()
    setBusy(label)
    setError('')
    try { await fn() } catch (err) { setError(err.message) } finally { setBusy('') }
  }
  const parse = run('parse', async () => setForm({ ...form, ...(await api('/ai/parse-job', { method: 'POST', body: { url: form.job_url } })) }))
  const create = run('create', async () => navigate(`/applications/${(await api('/applications', { method: 'POST', body: form })).id}`))

  return (
    <form className="card stack" onSubmit={create}>
      <div className="row">
        <input placeholder="Paste a job posting URL" value={form.job_url} onChange={set('job_url')} />
        <button type="button" onClick={parse} disabled={!form.job_url || busy}>{busy === 'parse' ? 'Reading…' : 'Autofill'}</button>
      </div>
      <div className="row">
        <input placeholder="Company" value={form.company} onChange={set('company')} required />
        <input placeholder="Position" value={form.position} onChange={set('position')} required />
      </div>
      <textarea rows={6} placeholder="Job description" value={form.job_description} onChange={set('job_description')} />
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>Add application</button>
      </div>
    </form>
  )
}

export default function Applications() {
  const [apps, setApps] = useState([])
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  useEffect(() => { api('/applications').then(setApps) }, [])
  const shown = filter ? apps.filter((a) => a.status === filter) : apps

  return (
    <div className="stack">
      <div className="pagehead">
        <h1>Applications</h1>
        {!adding && <button className="primary" onClick={() => setAdding(true)}>New application</button>}
      </div>
      {adding && <NewApplication onCancel={() => setAdding(false)} />}
      <div className="tabs">
        {['', ...STATUSES].map((s) => (
          <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {s || 'all'} <span className="muted">{s ? apps.filter((a) => a.status === s).length : apps.length}</span>
          </button>
        ))}
      </div>
      <div className="list">
        {shown.map((a) => (
          <Link key={a.id} to={`/applications/${a.id}`} className="item">
            <div>
              <strong>{a.position}</strong>
              <div className="muted">{a.company}</div>
            </div>
            <div className="row">
              <span className="muted small">{fmtDate(a.applied_at || a.created_at)}</span>
              <span className={`badge ${a.status}`}>{a.status}</span>
            </div>
          </Link>
        ))}
        {!shown.length && <p className="empty">No applications yet.</p>}
      </div>
    </div>
  )
}
