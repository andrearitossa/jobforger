import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, fmtDate, DOC_KINDS } from '../api'

export default function Docs({ kind }) {
  const [docs, setDocs] = useState([])
  const navigate = useNavigate()
  const load = () => api(`/docs/${kind}`).then(setDocs)
  useEffect(() => { load() }, [kind])

  const create = async (from) => {
    const name = prompt('Name', from ? `Copy of ${from.name}` : 'Untitled')
    if (name) navigate(`/${kind}/${(await api(`/docs/${kind}`, { method: 'POST', body: { name, from: from?.id } })).id}`)
  }
  const remove = async (d) => {
    if (confirm(`Delete "${d.name}"?`)) await api(`/docs/${kind}/${d.id}`, { method: 'DELETE' }).then(load)
  }

  return (
    <div className="stack">
      <div className="pagehead">
        <h1>{DOC_KINDS[kind]}</h1>
        <button className="primary" onClick={() => create()}>New</button>
      </div>
      <div className="list">
        {docs.map((d) => (
          <div key={d.id} className="item">
            <Link to={`/${kind}/${d.id}`} className="grow">
              <strong>{d.name}</strong>
              <div className="muted small">Edited {fmtDate(d.updated_at)}</div>
            </Link>
            <div className="row">
              <button className="ghost small" onClick={() => create(d)}>Duplicate</button>
              <button className="ghost small danger" onClick={() => remove(d)}>Delete</button>
            </div>
          </div>
        ))}
        {!docs.length && <p className="empty">Nothing here yet.</p>}
      </div>
    </div>
  )
}
