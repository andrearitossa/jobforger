import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, DOC_KINDS } from '../api'

export default function DocEditor({ kind }) {
  const { id } = useParams()
  const [params] = useSearchParams()
  const applicationId = params.get('app')
  const [doc, setDoc] = useState(null)
  const [latex, setLatex] = useState('')
  const [pdf, setPdf] = useState(null)
  const [log, setLog] = useState('')
  const [status, setStatus] = useState('')
  const saved = useRef('')

  const compile = useCallback(async (src) => {
    setStatus('Compiling…')
    try {
      const res = await api('/compile', { method: 'POST', body: { latex: src }, raw: true })
      const url = URL.createObjectURL(await res.blob())
      setPdf((old) => { if (old) URL.revokeObjectURL(old); return url })
      setLog('')
      setStatus('')
    } catch (err) {
      setLog(err.message)
      setStatus('Compile failed')
    }
  }, [])

  const load = () => api(`/docs/${kind}/${id}`).then((d) => {
    setDoc(d)
    setLatex(d.latex_content)
    saved.current = d.latex_content
    compile(d.latex_content)
  })
  useEffect(() => { load() }, [kind, id])

  // Copilot saves edits server-side; pull them in and recompile.
  useEffect(() => {
    const onAction = (e) => { if (e.detail.type === 'doc' && e.detail.id === id) load() }
    window.addEventListener('copilot:action', onAction)
    return () => window.removeEventListener('copilot:action', onAction)
  }, [id])

  const save = async (src = latex) => {
    if (src === saved.current) return compile(src)
    setStatus('Saving…')
    await api(`/docs/${kind}/${id}`, { method: 'PUT', body: { latex_content: src } })
    saved.current = src
    compile(src)
  }

  useEffect(() => {
    if (!doc || latex === saved.current) return
    const t = setTimeout(() => save(latex), 1200)
    window.copilotFlush = () => { clearTimeout(t); return save(latex) }
    return () => { clearTimeout(t); delete window.copilotFlush }
  }, [latex])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const rename = async () => {
    const name = prompt('Name', doc.name)
    if (name) { await api(`/docs/${kind}/${id}`, { method: 'PUT', body: { name } }); setDoc({ ...doc, name }) }
  }

  if (!doc) return null
  return (
    <div className="editor">
      <div className="pagehead">
        <div className="row">
          <Link to={applicationId ? `/applications/${applicationId}` : `/${kind}`} className="muted">←</Link>
          <h1 onClick={rename} title="Rename" className="clickable">{doc.name}</h1>
          <span className="muted small">{DOC_KINDS[kind]}</span>
        </div>
        <div className="row">
          <span className="muted small">{status || (latex !== saved.current ? 'Editing…' : 'Saved')}</span>
          {pdf && <a className="button primary-link" href={pdf} download={`${doc.name}.pdf`}>Download PDF</a>}
        </div>
      </div>
      <div className="panes">
        <textarea className="code" value={latex} onChange={(e) => setLatex(e.target.value)} spellCheck={false} />
        <div className="preview">
          {log ? <pre className="log">{log}</pre> : pdf ? <iframe src={pdf} title="PDF preview" /> : <p className="empty">Compiling…</p>}
        </div>
      </div>
    </div>
  )
}
