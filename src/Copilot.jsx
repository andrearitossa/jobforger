import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api } from './api'

// What the user is looking at, derived from the URL, so the copilot always has page context.
function usePage() {
  const { pathname, search } = useLocation()
  const [, kind, id] = pathname.split('/')
  const app = new URLSearchParams(search).get('app')
  if ((kind === 'cvs' || kind === 'cover-letters') && id) return { kind, docId: id, applicationId: app }
  if (kind === 'applications' && id) return { applicationId: id }
  return {}
}

function suggestions(page) {
  if (page.docId && page.applicationId) return ['Tailor this to the job', 'What would a recruiter flag?', 'Make it fit one page']
  if (page.docId) return ['Review this critically', 'Make the bullets punchier', 'Make it fit one page']
  if (page.applicationId) return ['Tailor a CV for this job', 'Write a cover letter', 'How well do I match?']
  return ['Which application should I focus on?', 'Improve my strongest CV', 'Prep me for an interview']
}

// Tiny markdown: **bold**, `code`, bullets and paragraphs. Escapes everything else.
function Markdown({ text }) {
  const inline = (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  const html = text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n')
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('')}</ul>`
    return `<p>${lines.map(inline).join('<br>')}</p>`
  }).join('')
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

// Names of what the copilot can see on this page, shown as a pill (like VS Code's attached context).
function useContextLabel(page) {
  const [label, setLabel] = useState('')
  useEffect(() => {
    let live = true
    setLabel('')
    const doc = page.docId && api(`/docs/${page.kind}/${page.docId}`).then((d) => (page.kind === 'cvs' ? 'CV · ' : 'Letter · ') + d.name)
    const app = page.applicationId && !page.docId && api(`/applications/${page.applicationId}`).then((a) => `Job · ${a.company}, ${a.position}`)
    Promise.all([doc, app].filter(Boolean)).then((l) => live && setLabel(l.join('  ')), () => {})
    return () => { live = false }
  }, [page.kind, page.docId, page.applicationId])
  return label
}

const store = {
  load: (k) => { try { return JSON.parse(localStorage.getItem(k)) || [] } catch { return [] } },
  save: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v.slice(-40))) } catch {} },
}

export default function Copilot({ user, open, onClose }) {
  const key = `copilot:${user.id}`
  const page = usePage()
  const contextLabel = useContextLabel(page)
  const navigate = useNavigate()
  const [messages, setMessages] = useState(() => store.load(key))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState('')
  const scroller = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => store.save(key, messages), [messages])
  useEffect(() => { scroller.current?.scrollTo({ top: 1e9, behavior: 'smooth' }) }, [messages, busy])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  const send = async (text) => {
    if (!text.trim() || busy) return
    await window.copilotFlush?.() // save any unsaved editor changes so the copilot sees them
    const history = [...messages, { role: 'user', content: text }]
    setMessages([...history, { role: 'assistant', content: '', actions: [] }])
    setInput('')
    setBusy('Thinking')
    const patch = (fn) => setMessages((m) => [...m.slice(0, -1), fn(m[m.length - 1])])
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, messages: history.map(({ role, content }) => ({ role, content })) }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += value
        const events = buf.split('\n\n')
        buf = events.pop()
        for (const e of events) {
          const ev = JSON.parse(e.replace(/^data: /, ''))
          if (ev.t === 'text') setBusy(''), patch((m) => ({ ...m, content: m.content + ev.v }))
          if (ev.t === 'working') setBusy({ edit_document: 'Editing document', create_document: 'Writing document', update_application: 'Updating application' }[ev.v] || 'Working')
          if (ev.t === 'error') throw new Error(ev.v)
          if (ev.t === 'action') {
            patch((m) => ({ ...m, actions: [...m.actions, ev] }))
            window.dispatchEvent(new CustomEvent('copilot:action', { detail: ev }))
            if (ev.created && page.applicationId && !page.docId) navigate(`/${ev.kind}/${ev.id}?app=${page.applicationId}`)
          }
        }
      }
    } catch (err) {
      patch((m) => ({ ...m, error: err.message }))
    } finally {
      setBusy('')
    }
  }

  return (
    <aside className={`copilot ${open ? 'open' : ''}`} aria-hidden={!open}>
      <header>
        <strong>Copilot</strong>
        <div className="row">
          {messages.length > 0 && <button className="ghost small" onClick={() => setMessages([])}>New chat</button>}
          <button className="ghost small" onClick={onClose} title="Close (Ctrl+K)">✕</button>
        </div>
      </header>

      <div className="messages" ref={scroller}>
        {!messages.length && (
          <div className="hello">
            <div className="spark">✦</div>
            <p>Hi {user.name.split(' ')[0]}. I can see your profile, documents and applications{page.docId ? ', and the document you have open' : page.applicationId ? ', and this application' : ''}.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'user' ? <p>{m.content}</p> : <Markdown text={m.content} />}
            {m.actions?.map((a, j) => (
              <Link key={j} className="action" to={a.type === 'doc' ? `/${a.kind}/${a.id}${page.applicationId ? `?app=${page.applicationId}` : ''}` : `/applications/${a.id}`}>✓ {a.label} →</Link>
            ))}
            {m.error && <p className="error">{m.error}</p>}
          </div>
        ))}
        {busy && <div className="typing">{busy}<span>.</span><span>.</span><span>.</span></div>}
      </div>

      <div className="composer">
        {!messages.length && (
          <div className="chips">
            {suggestions(page).map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {contextLabel && <div className="context" title="Copilot can see this">{contextLabel}</div>}
        <form onSubmit={(e) => { e.preventDefault(); send(input) }}>
          <textarea ref={inputRef} rows={1} value={input} placeholder="Ask anything…" onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }} />
          <button className="primary send" disabled={!input.trim() || !!busy} aria-label="Send">↑</button>
        </form>
      </div>
    </aside>
  )
}
