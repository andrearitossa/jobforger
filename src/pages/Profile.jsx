import { useEffect, useState } from 'react'
import { api } from '../api'

// Field config per list section: [column, label, input type]
const SECTIONS = {
  experiences: {
    title: 'Experience',
    heading: (x) => [x.role, x.company],
    fields: [['role', 'Role'], ['company', 'Company'], ['location', 'Location'], ['start_date', 'Start'], ['end_date', 'End'], ['bullets', 'Highlights (one per line)', 'lines']],
  },
  education: {
    title: 'Education',
    heading: (x) => [x.degree + (x.field ? `, ${x.field}` : ''), x.institution],
    fields: [['degree', 'Degree'], ['field', 'Field'], ['institution', 'Institution'], ['gpa', 'GPA'], ['start_date', 'Start'], ['end_date', 'End'], ['coursework', 'Coursework', 'text'], ['description', 'Description', 'text']],
  },
  projects: {
    title: 'Projects',
    heading: (x) => [x.name, x.tech_stack],
    fields: [['name', 'Name'], ['tech_stack', 'Tech stack'], ['url', 'URL'], ['repo_url', 'Repository'], ['description', 'Description', 'text']],
  },
}

const parseList = (v) => { try { return JSON.parse(v) || [] } catch { return v ? [v] : [] } }

function Entry({ table, item, onSaved, onCancel }) {
  const { fields } = SECTIONS[table]
  const [form, setForm] = useState(() => ({ ...item, bullets: parseList(item.bullets).join('\n') }))
  const save = async (e) => {
    e.preventDefault()
    const body = { ...form, bullets: JSON.stringify((form.bullets || '').split('\n').map((s) => s.trim()).filter(Boolean)) }
    await api(`/profile/${table}/${item.id}`, { method: 'PUT', body })
    onSaved()
  }
  const remove = async () => {
    if (!confirm('Delete this entry?')) return
    await api(`/profile/${table}/${item.id}`, { method: 'DELETE' })
    onSaved()
  }
  return (
    <form className="card fields" onSubmit={save}>
      {fields.map(([k, label, type]) => (
        <label key={k} className={type ? 'full' : ''}>
          {label}
          {type ? <textarea rows={4} value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            : <input value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} required={k === fields[0][0]} />}
        </label>
      ))}
      <div className="row between full">
        <button type="button" className="ghost danger" onClick={remove}>Delete</button>
        <div className="row">
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button className="primary">Save</button>
        </div>
      </div>
    </form>
  )
}

function Section({ table, items, reload }) {
  const [editing, setEditing] = useState(null)
  const { title, heading } = SECTIONS[table]
  const done = () => { setEditing(null); reload() }
  return (
    <section className="stack">
      <div className="pagehead">
        <h2>{title}</h2>
        <button className="ghost" onClick={() => setEditing({ id: crypto.randomUUID(), start_date: '' })}>+ Add</button>
      </div>
      {[...items, ...(editing && !items.some((x) => x.id === editing.id) ? [editing] : [])].map((x) =>
        editing?.id === x.id ? <Entry key={x.id} table={table} item={x} onSaved={done} onCancel={() => setEditing(null)} /> : (
          <div key={x.id} className="item clickable" onClick={() => setEditing(x)}>
            <div><strong>{heading(x)[0]}</strong><div className="muted">{heading(x)[1]}</div></div>
            <span className="muted small">{[x.start_date, x.end_date || (x.start_date && 'Present')].filter(Boolean).join(' – ')}</span>
          </div>
        ),
      )}
    </section>
  )
}

function Chips({ items, render, onAdd, onRemove, placeholder }) {
  const [value, setValue] = useState('')
  return (
    <div className="chips">
      {items.map((x, i) => <span key={x.id || i} className="chip">{render(x)}<button onClick={() => onRemove(x, i)}>×</button></span>)}
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onAdd(value.trim()); setValue('') }}>
        <input placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      </form>
    </div>
  )
}

export default function Profile() {
  const [p, setP] = useState(null)
  const reload = () => api('/profile').then(setP)
  useEffect(() => { reload() }, [])
  if (!p) return null

  const languages = parseList(p.languages)
  const saveInfo = (patch) => {
    const next = { ...p, ...patch }
    setP(next)
    return api('/profile', { method: 'PUT', body: next })
  }
  const info = (k, label, props = {}) => (
    <label className={props.rows ? 'full' : ''}>
      {label}
      {props.rows ? <textarea {...props} defaultValue={p[k] || ''} onBlur={(e) => saveInfo({ [k]: e.target.value })} />
        : <input {...props} defaultValue={p[k] || ''} onBlur={(e) => saveInfo({ [k]: e.target.value })} />}
    </label>
  )

  return (
    <div className="stack wide">
      <div className="pagehead">
        <div><h1>Profile</h1><p className="muted">Everything the AI knows about you. Changes save automatically.</p></div>
      </div>
      <section className="card fields">
        {info('name', 'Name')}
        <label>Email<input value={p.email} disabled /></label>
        {info('phone', 'Phone')}
        {info('location', 'Location')}
        {info('linkedin_url', 'LinkedIn')}
        {info('github', 'GitHub')}
        {info('website', 'Website')}
        {info('summary', 'Summary', { rows: 4 })}
      </section>

      {Object.keys(SECTIONS).map((t) => <Section key={t} table={t} items={p[t]} reload={reload} />)}

      <section className="stack">
        <h2>Skills</h2>
        <Chips items={p.skills} render={(s) => s.name} placeholder="Add a skill and press Enter"
          onAdd={(name) => api(`/profile/skills/${crypto.randomUUID()}`, { method: 'PUT', body: { name } }).then(reload)}
          onRemove={(s) => api(`/profile/skills/${s.id}`, { method: 'DELETE' }).then(reload)} />
      </section>

      <section className="stack">
        <h2>Languages</h2>
        <Chips items={languages} render={(l) => `${l.name}${l.proficiency ? ` · ${l.proficiency}` : ''}`} placeholder="e.g. Italian · Native"
          onAdd={(v) => { const [name, proficiency = ''] = v.split(/\s*[·:-]\s*/); saveInfo({ languages: JSON.stringify([...languages, { name, proficiency }]) }) }}
          onRemove={(_, i) => saveInfo({ languages: JSON.stringify(languages.filter((_, j) => j !== i)) })} />
      </section>
    </div>
  )
}
