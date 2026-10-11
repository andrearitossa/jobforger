import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, STATUSES } from '../api'

function DocPicker({ kind, label, app, docs, update, reload }) {
  const field = kind === 'cvs' ? 'cv_id' : 'cover_letter_id'
  const [busy, setBusy] = useState(false)
  const generate = async () => {
    setBusy(true)
    try { await api(`/ai/generate/${app.id}`, { method: 'POST', body: { kind } }); await reload() }
    catch (err) { alert(err.message) } finally { setBusy(false) }
  }
  return (
    <div className="stack tight">
      <label>{label}</label>
      <div className="row">
        <select value={app[field] || ''} onChange={(e) => update({ [field]: e.target.value })}>
          <option value="">None</option>
          {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {app[field] && <Link className="button" to={`/${kind}/${app[field]}?app=${app.id}`}>Open</Link>}
        <button onClick={generate} disabled={busy}>{busy ? 'Writing…' : 'Tailor with AI'}</button>
      </div>
    </div>
  )
}

function Question({ q, appId, reload }) {
  const [answer, setAnswer] = useState(q.answer || '')
  const [busy, setBusy] = useState(false)
  useEffect(() => setAnswer(q.answer || ''), [q.answer])
  const path = `/applications/${appId}/questions/${q.id}`
  const draft = async () => {
    setBusy(true)
    try { await api(`/ai/answer/${appId}/${q.id}`, { method: 'POST' }); await reload() }
    catch (err) { alert(err.message) } finally { setBusy(false) }
  }
  return (
    <div className="card stack tight">
      <div className="row between">
        <strong>{q.question}</strong>
        <button className="ghost small" onClick={async () => { await api(path, { method: 'DELETE' }); reload() }}>Remove</button>
      </div>
      <textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)}
        onBlur={() => answer !== (q.answer || '') && api(path, { method: 'PUT', body: { answer } })} />
      <div className="row end">
        <button onClick={() => navigator.clipboard.writeText(answer)} disabled={!answer} className="ghost">Copy</button>
        <button onClick={draft} disabled={busy}>{busy ? 'Drafting…' : 'Draft with AI'}</button>
      </div>
    </div>
  )
}

export default function Application() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [app, setApp] = useState(null)
  const [docs, setDocs] = useState({ cvs: [], 'cover-letters': [] })
  const [question, setQuestion] = useState('')

  const reload = async () => {
    const [a, cvs, cls] = await Promise.all([api(`/applications/${id}`), api('/docs/cvs'), api('/docs/cover-letters')])
    setApp(a)
    setDocs({ cvs, 'cover-letters': cls })
  }
  useEffect(() => { reload() }, [id])
  if (!app) return null

  const update = async (patch) => {
    setApp({ ...app, ...patch })
    await api(`/applications/${id}`, { method: 'PUT', body: patch })
  }
  const field = (k, props = {}) => {
    const Tag = props.rows ? 'textarea' : 'input'
    return <Tag {...props} defaultValue={app[k] || ''} onBlur={(e) => e.target.value !== (app[k] || '') && update({ [k]: e.target.value })} />
  }
  const addQuestion = async (e) => {
    e.preventDefault()
    await api(`/applications/${id}/questions`, { method: 'POST', body: { question } })
    setQuestion('')
    reload()
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
          <div className="stack tight"><label>Job description</label>{field('job_description', { rows: 12 })}</div>
        </div>
        <div className="stack">
          <DocPicker kind="cvs" label="CV" app={app} docs={docs.cvs} update={update} reload={reload} />
          <DocPicker kind="cover-letters" label="Cover letter" app={app} docs={docs['cover-letters']} update={update} reload={reload} />
          <div className="stack tight"><label>Notes</label>{field('notes', { rows: 6 })}</div>
        </div>
      </section>

      <section className="stack">
        <h2>Application questions</h2>
        {app.questions.map((q) => <Question key={q.id} q={q} appId={id} reload={reload} />)}
        <form className="row" onSubmit={addQuestion}>
          <input placeholder="e.g. Why do you want to work here?" value={question} onChange={(e) => setQuestion(e.target.value)} required />
          <button>Add question</button>
        </form>
      </section>

      <div><button className="ghost danger" onClick={remove}>Delete application</button></div>
    </div>
  )
}
