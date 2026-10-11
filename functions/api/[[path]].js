import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

const app = new Hono().basePath('/api')
const now = () => Math.floor(Date.now() / 1000)
const uid = () => crypto.randomUUID()

// ---------- crypto helpers ----------

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)))

async function pbkdf2(password, salt, iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
}

async function hashPassword(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)))
  return { password_hash: hex(await pbkdf2(password, unhex(salt))), password_salt: salt }
}

// The original codebase is lost, so accept the common schemes it may have used.
async function verifyPassword(password, { password_hash: h, password_salt: s }) {
  const salts = [enc.encode(s)]
  if (/^([0-9a-f]{2})+$/i.test(s)) salts.unshift(unhex(s))
  for (const salt of salts) {
    for (const it of [100000, 10000]) {
      const bits = await pbkdf2(password, salt, it)
      if (h === hex(bits) || h === b64(bits)) return true
    }
  }
  for (const v of [s + password, password + s]) {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(v))
    if (h === hex(d) || h === b64(d)) return true
  }
  return false
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)))
}

// ---------- session ----------

const SESSION_DAYS = 30

async function startSession(c, userId) {
  const payload = `${userId}.${now() + SESSION_DAYS * 86400}`
  setCookie(c, 'session', `${payload}.${await sign(payload, c.env.SESSION_SECRET)}`, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400,
  })
}

app.use('*', async (c, next) => {
  // Without a secret every session would be forgeable, so refuse to serve at all.
  if (!c.env.SESSION_SECRET) return c.json({ error: 'Server misconfigured: SESSION_SECRET is not set' }, 500)
  const [id, exp, sig] = (getCookie(c, 'session') || '').split('.')
  if (sig && +exp > now() && sig === (await sign(`${id}.${exp}`, c.env.SESSION_SECRET))) c.set('userId', id)
  if (!c.get('userId') && !c.req.path.startsWith('/api/auth/')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message || 'Something went wrong' }, 500)
})

// ---------- auth ----------

app.post('/auth/register', async (c) => {
  const { name, email, password } = await c.req.json()
  if (!name || !email || !password || password.length < 8) return c.json({ error: 'Name, email and an 8+ character password are required' }, 400)
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email.toLowerCase()).first()
  if (exists) return c.json({ error: 'An account with this email already exists' }, 409)
  const id = uid()
  const { password_hash, password_salt } = await hashPassword(password)
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, email.toLowerCase(), password_hash, password_salt, name, now()),
    c.env.DB.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').bind(uid(), id),
  ])
  await startSession(c, id)
  return c.json({ id, name, email })
})

app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind((email || '').toLowerCase()).first()
  if (!user || !(await verifyPassword(password || '', user))) return c.json({ error: 'Invalid email or password' }, 401)
  await startSession(c, user.id)
  return c.json({ id: user.id, name: user.name, email: user.email })
})

app.post('/auth/logout', (c) => {
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})

app.get('/auth/me', async (c) => {
  if (!c.get('userId')) return c.json(null)
  return c.json(await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(c.get('userId')).first())
})

// ---------- profile ----------

// Columns editable per list table; anything else in a request body is ignored.
const LISTS = {
  experiences: ['company', 'role', 'location', 'start_date', 'end_date', 'description', 'bullets', 'order'],
  education: ['institution', 'degree', 'field', 'start_date', 'end_date', 'gpa', 'description', 'coursework', 'order'],
  projects: ['name', 'description', 'tech_stack', 'url', 'repo_url', 'start_date', 'end_date', 'order'],
  skills: ['name', 'category', 'proficiency'],
}
const PROFILE_FIELDS = ['summary', 'phone', 'location', 'website', 'linkedin_url', 'github', 'languages']

async function loadProfile(db, userId) {
  const q = (sql) => db.prepare(sql).bind(userId)
  const [user, profile, ...lists] = await db.batch([
    q('SELECT name, email FROM users WHERE id = ?'),
    q('SELECT * FROM profiles WHERE user_id = ?'),
    ...Object.keys(LISTS).map((t) => q(`SELECT * FROM ${t} WHERE user_id = ? ORDER BY ${t === 'skills' ? 'category, name' : '"order", start_date DESC'}`)),
  ])
  return {
    ...user.results[0],
    ...(profile.results[0] || {}),
    ...Object.fromEntries(Object.keys(LISTS).map((t, i) => [t, lists[i].results])),
  }
}

app.get('/profile', async (c) => c.json(await loadProfile(c.env.DB, c.get('userId'))))

app.put('/profile', async (c) => {
  const body = await c.req.json()
  const userId = c.get('userId')
  if (body.name) await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(body.name, userId).run()
  const vals = PROFILE_FIELDS.map((f) => body[f] ?? null)
  await c.env.DB.prepare(
    `INSERT INTO profiles (id, user_id, ${PROFILE_FIELDS.join(', ')}) VALUES (?, ?, ${PROFILE_FIELDS.map(() => '?').join(', ')})
     ON CONFLICT(user_id) DO UPDATE SET ${PROFILE_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')}`,
  ).bind(uid(), userId, ...vals).run()
  return c.json({ ok: true })
})

app.put('/profile/:table/:id', async (c) => {
  const cols = LISTS[c.req.param('table')]
  if (!cols) return c.notFound()
  const body = await c.req.json()
  const quoted = cols.map((k) => `"${k}"`)
  await c.env.DB.prepare(
    `INSERT INTO ${c.req.param('table')} (id, user_id, ${quoted.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${quoted.map((k) => `${k} = excluded.${k}`).join(', ')} WHERE user_id = excluded.user_id`,
  ).bind(c.req.param('id'), c.get('userId'), ...cols.map((k) => body[k] ?? null)).run()
  return c.json({ ok: true })
})

app.delete('/profile/:table/:id', async (c) => {
  if (!LISTS[c.req.param('table')]) return c.notFound()
  await c.env.DB.prepare(`DELETE FROM ${c.req.param('table')} WHERE id = ? AND user_id = ?`).bind(c.req.param('id'), c.get('userId')).run()
  return c.json({ ok: true })
})

// ---------- documents (CVs and cover letters share one shape) ----------

const KINDS = { cvs: 'cvs', 'cover-letters': 'cover_letters' }

app.get('/docs/:kind', async (c) => {
  const t = KINDS[c.req.param('kind')]
  if (!t) return c.notFound()
  const { results } = await c.env.DB.prepare(`SELECT id, name, updated_at FROM ${t} WHERE user_id = ? ORDER BY updated_at DESC`).bind(c.get('userId')).all()
  return c.json(results)
})

app.get('/docs/:kind/:id', async (c) => {
  const t = KINDS[c.req.param('kind')]
  const doc = t && (await c.env.DB.prepare(`SELECT * FROM ${t} WHERE id = ? AND user_id = ?`).bind(c.req.param('id'), c.get('userId')).first())
  return doc ? c.json(doc) : c.notFound()
})

async function createDoc(db, userId, kind, name, latex) {
  const id = uid()
  await db.prepare(`INSERT INTO ${KINDS[kind]} (id, user_id, name, latex_content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, userId, name, latex, now(), now()).run()
  return id
}

app.post('/docs/:kind', async (c) => {
  const kind = c.req.param('kind')
  if (!KINDS[kind]) return c.notFound()
  const { name, latex_content, from } = await c.req.json()
  let latex = latex_content
  if (from) latex = (await c.env.DB.prepare(`SELECT latex_content FROM ${KINDS[kind]} WHERE id = ? AND user_id = ?`).bind(from, c.get('userId')).first())?.latex_content
  return c.json({ id: await createDoc(c.env.DB, c.get('userId'), kind, name || 'Untitled', latex || TEMPLATES[kind]) })
})

app.put('/docs/:kind/:id', async (c) => {
  const t = KINDS[c.req.param('kind')]
  if (!t) return c.notFound()
  const { name, latex_content } = await c.req.json()
  await c.env.DB.prepare(`UPDATE ${t} SET name = COALESCE(?, name), latex_content = COALESCE(?, latex_content), updated_at = ? WHERE id = ? AND user_id = ?`)
    .bind(name ?? null, latex_content ?? null, now(), c.req.param('id'), c.get('userId')).run()
  return c.json({ ok: true })
})

app.delete('/docs/:kind/:id', async (c) => {
  const t = KINDS[c.req.param('kind')]
  if (!t) return c.notFound()
  const col = t === 'cvs' ? 'cv_id' : 'cover_letter_id'
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE applications SET ${col} = NULL WHERE ${col} = ? AND user_id = ?`).bind(c.req.param('id'), c.get('userId')),
    c.env.DB.prepare(`DELETE FROM ${t} WHERE id = ? AND user_id = ?`).bind(c.req.param('id'), c.get('userId')),
  ])
  return c.json({ ok: true })
})

// Proxied so the browser avoids CORS and the compile service stays swappable.
app.post('/compile', async (c) => {
  const { latex } = await c.req.json()
  const res = await fetch(c.env.LATEX_COMPILE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compiler: 'pdflatex', resources: [{ main: true, content: latex }] }),
  })
  if (!res.ok) {
    const text = await res.text()
    let log = text
    try { log = Object.values(JSON.parse(text).log_files || {}).join('\n') || text } catch {}
    const lines = log.split('\n')
    const errors = lines.flatMap((l, i) => (/^(!|.*\.tex:\d+:)/.test(l) ? lines.slice(i, i + 3) : [])).join('\n')
    return c.json({ error: errors || log.slice(-2000) }, 422)
  }
  return new Response(res.body, { headers: { 'Content-Type': 'application/pdf' } })
})

// ---------- applications ----------

const APP_FIELDS = ['company', 'position', 'job_url', 'job_description', 'status', 'cv_id', 'cover_letter_id', 'notes', 'applied_at']

app.get('/applications', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, company, position, status, job_url, applied_at, created_at FROM applications WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(c.get('userId')).all()
  return c.json(results)
})

async function loadApplication(db, userId, id) {
  return db.prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?').bind(id, userId).first()
}

app.get('/applications/:id', async (c) => {
  const a = await loadApplication(c.env.DB, c.get('userId'), c.req.param('id'))
  return a ? c.json(a) : c.notFound()
})

app.post('/applications', async (c) => {
  const body = await c.req.json()
  if (!body.company || !body.position) return c.json({ error: 'Company and position are required' }, 400)
  const id = uid()
  await c.env.DB.prepare(`INSERT INTO applications (id, user_id, ${APP_FIELDS.join(', ')}, created_at) VALUES (?, ?, ${APP_FIELDS.map(() => '?').join(', ')}, ?)`)
    .bind(id, c.get('userId'), ...APP_FIELDS.map((f) => body[f] ?? (f === 'status' ? 'wishlist' : null)), now()).run()
  return c.json({ id })
})

app.put('/applications/:id', async (c) => {
  const body = await c.req.json()
  const fields = APP_FIELDS.filter((f) => f in body)
  if (body.status === 'applied' && !('applied_at' in body)) (body.applied_at = now()), fields.push('applied_at')
  if (fields.length) {
    await c.env.DB.prepare(`UPDATE applications SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...fields.map((f) => body[f] || null), c.req.param('id'), c.get('userId')).run()
  }
  return c.json({ ok: true })
})

app.delete('/applications/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM applications WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('userId')).run()
  return c.json({ ok: true })
})

// ---------- AI ----------

async function ai(env, system, user) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-6-luna',
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system + '\nRespond with a JSON object only.' }, { role: 'user', content: user }],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI error: ${(await res.text()).slice(0, 300)}`)
  return JSON.parse((await res.json()).choices[0].message.content)
}

const profileText = (p) => JSON.stringify(p, (k, v) => (['id', 'user_id', 'order', 'image_url'].includes(k) || v === null || v === '' ? undefined : v))
const jobText = (a) => `Company: ${a.company}\nPosition: ${a.position}\n\n${a.job_description || ''}`

app.post('/ai/parse-job', async (c) => {
  const { url } = await c.req.json()
  const html = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Jobforger)' } })).text()
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 30000)
  return c.json(await ai(c.env,
    'Extract the job posting from this web page text. Return {"company": string, "position": string, "job_description": string}. The job_description should be a clean, complete plain-text summary of responsibilities and requirements.',
    text))
})

// ---------- copilot ----------

const TOOLS = [
  {
    name: 'edit_document',
    description: 'Edit an existing CV or cover letter by exact find-and-replace. Each "find" must be copied verbatim from the current LaTeX and be unique; keep edits small and targeted.',
    parameters: {
      kind: { type: 'string', enum: ['cvs', 'cover-letters'] },
      id: { type: 'string' },
      edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } },
    },
    required: ['kind', 'id', 'edits'],
  },
  {
    name: 'create_document',
    description: 'Create a new CV or cover letter (e.g. tailored to an application). Optionally attach it to an application.',
    parameters: { kind: { type: 'string', enum: ['cvs', 'cover-letters'] }, name: { type: 'string' }, latex: { type: 'string' }, application_id: { type: 'string' } },
    required: ['kind', 'name', 'latex'],
  },
  {
    name: 'update_application',
    description: 'Update fields of a job application.',
    parameters: { id: { type: 'string' }, status: { type: 'string', enum: ['wishlist', 'applied', 'interview', 'offer', 'rejected'] }, notes: { type: 'string' }, cv_id: { type: 'string' }, cover_letter_id: { type: 'string' } },
    required: ['id'],
  },
].map(({ name, description, parameters, required }) => ({ type: 'function', name, description, parameters: { type: 'object', properties: parameters, required } }))

// Runs a tool call for the user and returns [result for the model, event for the UI].
async function runTool(db, userId, name, args) {
  if (name === 'edit_document') {
    const t = KINDS[args.kind]
    const doc = t && (await db.prepare(`SELECT name, latex_content FROM ${t} WHERE id = ? AND user_id = ?`).bind(args.id, userId).first())
    if (!doc) return ['Document not found']
    let latex = doc.latex_content
    for (const { find, replace } of args.edits || []) {
      const n = latex.split(find).length - 1
      if (n !== 1) return [`Edit failed: "${find.slice(0, 80)}" matched ${n} times. Nothing was saved; copy the text exactly and make it unique.`]
      latex = latex.replace(find, () => replace)
    }
    await db.prepare(`UPDATE ${t} SET latex_content = ?, updated_at = ? WHERE id = ?`).bind(latex, now(), args.id).run()
    const n = args.edits.length
    return ['Saved', { type: 'doc', kind: args.kind, id: args.id, label: `Edited ${doc.name} · ${n} change${n > 1 ? 's' : ''}` }]
  }
  if (name === 'create_document') {
    if (!KINDS[args.kind]) return ['Unknown kind']
    const id = await createDoc(db, userId, args.kind, args.name, args.latex)
    if (args.application_id && (await loadApplication(db, userId, args.application_id))) {
      await db.prepare(`UPDATE applications SET ${args.kind === 'cvs' ? 'cv_id' : 'cover_letter_id'} = ? WHERE id = ?`).bind(id, args.application_id).run()
    }
    return [`Created with id ${id}`, { type: 'doc', kind: args.kind, id, label: `Created ${args.name}`, created: true }]
  }
  if (name === 'update_application') {
    const a = await loadApplication(db, userId, args.id)
    if (!a) return ['Application not found']
    const fields = ['status', 'notes', 'cv_id', 'cover_letter_id'].filter((f) => args[f] !== undefined)
    if (args.status === 'applied' && !a.applied_at) (args.applied_at = now()), fields.push('applied_at')
    if (fields.length) await db.prepare(`UPDATE applications SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).bind(...fields.map((f) => args[f]), a.id).run()
    return ['Saved', { type: 'application', id: a.id, label: `Updated ${a.company} application` }]
  }
  return ['Unknown tool']
}

async function copilotContext(db, userId, page) {
  const [profile, cvs, cls, apps] = await Promise.all([
    loadProfile(db, userId),
    db.prepare('SELECT id, name FROM cvs WHERE user_id = ? ORDER BY updated_at DESC').bind(userId).all(),
    db.prepare('SELECT id, name FROM cover_letters WHERE user_id = ? ORDER BY updated_at DESC').bind(userId).all(),
    db.prepare('SELECT id, company, position, status, cv_id, cover_letter_id FROM applications WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all(),
  ])
  const parts = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `## Candidate profile\n${profileText(profile)}`,
    `## CVs\n${JSON.stringify(cvs.results)}`,
    `## Cover letters\n${JSON.stringify(cls.results)}`,
    `## Applications\n${JSON.stringify(apps.results)}`,
  ]
  const docText = async (kind, id) => {
    const d = id && KINDS[kind] && (await db.prepare(`SELECT id, name, latex_content FROM ${KINDS[kind]} WHERE id = ? AND user_id = ?`).bind(id, userId).first())
    return d ? `### ${kind === 'cvs' ? 'CV' : 'Cover letter'} "${d.name}" (kind: ${kind}, id: ${d.id})\n${d.latex_content}` : ''
  }
  let appId = page?.applicationId
  // A document opened from the documents list still belongs to the job it's attached to.
  if (page?.docId && !appId && KINDS[page.kind]) {
    appId = (await db.prepare(`SELECT id FROM applications WHERE user_id = ? AND ${page.kind === 'cvs' ? 'cv_id' : 'cover_letter_id'} = ? ORDER BY created_at DESC`).bind(userId, page.docId).first())?.id
  }
  if (page?.docId) parts.push(`## The user is viewing this document\n${await docText(page.kind, page.docId)}`)
  if (appId) {
    const a = await loadApplication(db, userId, appId)
    if (a) {
      parts.push(`## ${page.docId ? 'This document is for' : 'The user is viewing'} this application (id: ${a.id})\n${jobText(a)}\nStatus: ${a.status}\nNotes: ${a.notes || ''}`)
      if (!page?.docId) parts.push(await docText('cvs', a.cv_id), await docText('cover-letters', a.cover_letter_id))
    }
  }
  return parts.filter(Boolean).join('\n\n')
}

const COPILOT_PROMPT = `You are Jobforger's copilot: a sharp, warm career coach and LaTeX expert helping the user land jobs.
You see their profile, documents and applications below, plus what they are looking at right now.
- Be brief and direct, like a great colleague in chat. Short paragraphs or bullets; no preamble.
- When the user asks to change a document, act immediately with edit_document (small exact find/replace edits), then say in one line what changed. Don't paste LaTeX into chat or ask for confirmation.
- To tailor a CV or cover letter to a job, call create_document (attach it via application_id) unless they want the current one edited.
- Never invent experience, employers, dates, numbers or skills that aren't in the profile or documents. If something is missing, ask.
- For application questions or emails, write the text directly in chat, ready to copy.`

app.post('/chat', async (c) => {
  if (!c.env.OPENAI_API_KEY) return c.json({ error: 'OPENAI_API_KEY is not configured' }, 500)
  const { messages = [], page } = await c.req.json()
  const userId = c.get('userId')
  const instructions = `${COPILOT_PROMPT}\n\n${await copilotContext(c.env.DB, userId, page)}`
  let input = messages.slice(-20).map(({ role, content }) => ({ role: role === 'user' ? 'user' : 'assistant', content: String(content) }))
  let previous
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const send = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))

  // OpenAI Responses API: stream text, run any tool calls, then continue from the previous response.
  c.executionCtx.waitUntil((async () => {
    try {
      for (let round = 0; round < 4; round++) {
        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: c.env.OPENAI_MODEL || 'gpt-6-luna', instructions, input, tools: TOOLS, stream: true, previous_response_id: previous, reasoning: { effort: 'none' } }),
        })
        if (!res.ok) throw new Error(`OpenAI error: ${(await res.text()).slice(0, 300)}`)
        const calls = []
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += value
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const ev = JSON.parse(line.slice(6))
            if (ev.type === 'response.output_text.delta') send({ t: 'text', v: ev.delta })
            else if (ev.type === 'response.output_item.added' && ev.item.type === 'function_call') send({ t: 'working', v: ev.item.name })
            else if (ev.type === 'response.output_item.done' && ev.item.type === 'function_call') calls.push(ev.item)
            else if (ev.type === 'response.completed') previous = ev.response.id
            else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(ev.response?.error?.message || ev.message || 'OpenAI request failed')
          }
        }
        if (!calls.length) break
        input = []
        for (const k of calls) {
          let result, event
          try { [result, event] = await runTool(c.env.DB, userId, k.name, JSON.parse(k.arguments || '{}')) } catch (err) { result = `Error: ${err.message}` }
          if (event) send({ t: 'action', ...event })
          input.push({ type: 'function_call_output', call_id: k.call_id, output: result })
        }
      }
    } catch (err) {
      send({ t: 'error', v: err.message })
    }
    await writer.close()
  })())

  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
})

// ---------- templates ----------

const TEMPLATES = {
  cvs: String.raw`\documentclass[11pt]{article}
\usepackage[margin=0.7in]{geometry}
\usepackage[hidelinks]{hyperref}
\usepackage{enumitem}
\setlist{nosep,leftmargin=*}
\pagestyle{empty}
\renewcommand{\section}[1]{\vspace{8pt}{\large\bfseries #1}\\[-6pt]\rule{\linewidth}{0.4pt}\vspace{2pt}}
\begin{document}
\begin{center}
{\LARGE\bfseries Your Name}\\[4pt]
email@example.com \textbar{} +00 000 000 \textbar{} City \textbar{} linkedin.com/in/you
\end{center}

\section{Experience}
\textbf{Role} \hfill Start -- End\\
\textit{Company}, City
\begin{itemize}
  \item Achievement with measurable impact.
\end{itemize}

\section{Education}
\textbf{Degree, Field} \hfill Start -- End\\
\textit{Institution}

\section{Skills}
Skill, Skill, Skill
\end{document}
`,
  'cover-letters': String.raw`\documentclass[11pt]{letter}
\usepackage[margin=1in]{geometry}
\pagestyle{empty}
\signature{Your Name}
\address{Your Name \\ City \\ email@example.com}
\begin{document}
\begin{letter}{Hiring Team \\ Company}
\opening{Dear Hiring Team,}

Why this role, and why you.

What you have done that matters for them.

\closing{Kind regards,}
\end{letter}
\end{document}
`,
}

export const onRequest = (ctx) => app.fetch(ctx.request, ctx.env, ctx)
