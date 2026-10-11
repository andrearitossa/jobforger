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
  const [message, setMessage] = useState('')
  const [replies, setReplies] = useState([])
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

  useEffect(() => {
    api(`/docs/${kind}/${id}`).then((d) => {
      setDoc(d)
      setLatex(d.latex_content)
      saved.current = d.latex_content
      compile(d.latex_content)
    })
  }, [kind, id])

  const save = async (src = latex) => {
    if (src === saved.current) return compile(src)
    setStatus('Saving…')
    await api(`/docs/${kind}/${id}`, { method: 'PUT', body: { latex_content: src } })
    saved.current = src
    compile(src)
  }

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const askAI = async (e) => {
    e.preventDefault()
    if (latex !== saved.current) await save()
    const text = message
    setMessage('')
    setReplies((r) => [...r, { me: true, text }])
    setStatus('Thinking…')
    try {
      const out = await api(`/ai/edit/${kind}/${id}`, { method: 'POST', body: { message: text, applicationId } })
      setReplies((r) => [...r, { text: out.reply }])
      setLatex(out.latex)
      await save(out.latex)
    } catch (err) {
      setReplies((r) => [...r, { text: err.message, error: true }])
      setStatus('')
    }
  }

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
          <span className="muted small">{status || (latex !== saved.current ? 'Unsaved' : '')}</span>
          {pdf && <a className="button" href={pdf} download={`${doc.name}.pdf`}>Download PDF</a>}
          <button className="primary" onClick={() => save()}>Save & compile</button>
        </div>
      </div>
      <div className="panes">
        <div className="stack">
          <textarea className="code" value={latex} onChange={(e) => setLatex(e.target.value)} spellCheck={false} />
          <div className="chat">
            {replies.map((r, i) => <p key={i} className={r.me ? 'me' : r.error ? 'error' : ''}>{r.text}</p>)}
            <form className="row" onSubmit={askAI}>
              <input placeholder={applicationId ? 'Ask AI, e.g. “tailor the summary to this job”' : 'Ask AI, e.g. “make it fit on one page”'} value={message} onChange={(e) => setMessage(e.target.value)} required />
              <button disabled={status === 'Thinking…'}>Send</button>
            </form>
          </div>
        </div>
        <div className="preview">
          {log ? <pre className="log">{log}</pre> : pdf ? <iframe src={pdf} title="PDF preview" /> : <p className="empty">Compiling…</p>}
        </div>
      </div>
    </div>
  )
}
