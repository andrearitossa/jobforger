import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, STATUSES } from '../api'

function DocPicker({ kind, label, value, docs, appId, onChange }) {
  return (
    <div className="stack tight">
      <label>{label}</label>
      <div className="row">
        <select className="grow" value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">None — ask Copilot to tailor one</option>
          {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {value && <Link className="button" to={`/${kind}/${value}?app=${appId}`}>Open</Link>}
      </div>
    </div>
  )
}

export default function Application() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [app, setApp] = useState(null)
  const [docs, setDocs] = useState({ cvs: [], 'cover-letters': [] })

  const reload = async () => {
    const [a, cvs, cls] = await Promise.all([api(`/applications/${id}`), api('/docs/cvs'), api('/docs/cover-letters')])
    setApp(a)
    setDocs({ cvs, 'cover-letters': cls })
  }
  useEffect(() => { reload() }, [id])
  useEffect(() => {
    window.addEventListener('copilot:action', reload)
    return () => window.removeEventListener('copilot:action', reload)
  }, [id])
  if (!app) return null

  const update = async (patch) => {
    setApp({ ...app, ...patch })
    await api(`/applications/${id}`, { method: 'PUT', body: patch })
  }
  const field = (k, props = {}) => {
    const Tag = props.rows ? 'textarea' : 'input'
    return <Tag key={`${k}:${app[k]}`} {...props} defaultValue={app[k] || ''} onBlur={(e) => e.target.value !== (app[k] || '') && update({ [k]: e.target.value })} />
  }
  const remove = async () => {
    if (!confirm('Delete this application?')) return
    await api(`/applications/${id}`, { method: 'DELETE' })
    navigate('/')
  }

  return (
    <div className="stack wide">
      <Link to="/" className="muted small">← Applications</Link>
      <div className="pagehead">
        <div>
          <h1>{app.position}</h1>
          <div className="muted">{app.company}{app.job_url && <> · <a href={app.job_url} target="_blank" rel="noreferrer">Job posting ↗</a></>}</div>
        </div>
        <select value={app.status || 'wishlist'} onChange={(e) => update({ status: e.target.value })} className={`badge ${app.status}`}>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      <section className="grid2">
        <div className="stack">
          <div className="row">
            <div className="stack tight grow"><label>Company</label>{field('company')}</div>
            <div className="stack tight grow"><label>Position</label>{field('position')}</div>
          </div>
          <div className="stack tight"><label>Job URL</label>{field('job_url')}</div>
          <div className="stack tight"><label>Job description</label>{field('job_description', { rows: 14 })}</div>
        </div>
        <div className="stack">
          <DocPicker kind="cvs" label="CV" value={app.cv_id} docs={docs.cvs} appId={id} onChange={(v) => update({ cv_id: v })} />
          <DocPicker kind="cover-letters" label="Cover letter" value={app.cover_letter_id} docs={docs['cover-letters']} appId={id} onChange={(v) => update({ cover_letter_id: v })} />
          <div className="stack tight"><label>Notes</label>{field('notes', { rows: 8 })}</div>
          <div><button className="ghost danger small" onClick={remove}>Delete application</button></div>
        </div>
      </section>
    </div>
  )
}
