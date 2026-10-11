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
  const app = await db.prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?').bind(id, userId).first()
  if (app) app.questions = (await db.prepare('SELECT * FROM application_questions WHERE application_id = ? ORDER BY created_at').bind(id).all()).results
  return app
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

app.post('/applications/:id/questions', async (c) => {
  const a = await loadApplication(c.env.DB, c.get('userId'), c.req.param('id'))
  if (!a) return c.notFound()
  const { question } = await c.req.json()
  await c.env.DB.prepare('INSERT INTO application_questions (id, application_id, question, created_at) VALUES (?, ?, ?, ?)')
    .bind(uid(), a.id, question, now()).run()
  return c.json({ ok: true })
})

app.put('/applications/:id/questions/:qid', async (c) => {
  const { answer } = await c.req.json()
  await c.env.DB.prepare(
    'UPDATE application_questions SET answer = ?, ai_generated = 0 WHERE id = ? AND application_id IN (SELECT id FROM applications WHERE user_id = ?)',
  ).bind(answer, c.req.param('qid'), c.get('userId')).run()
  return c.json({ ok: true })
})

app.delete('/applications/:id/questions/:qid', async (c) => {
  await c.env.DB.prepare('DELETE FROM application_questions WHERE id = ? AND application_id IN (SELECT id FROM applications WHERE user_id = ?)')
    .bind(c.req.param('qid'), c.get('userId')).run()
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

app.post('/ai/edit/:kind/:id', async (c) => {
  const t = KINDS[c.req.param('kind')]
  const doc = t && (await c.env.DB.prepare(`SELECT * FROM ${t} WHERE id = ? AND user_id = ?`).bind(c.req.param('id'), c.get('userId')).first())
  if (!doc) return c.notFound()
  const { message, applicationId } = await c.req.json()
  const job = applicationId && (await loadApplication(c.env.DB, c.get('userId'), applicationId))
  const out = await ai(c.env,
    `You edit LaTeX ${t === 'cvs' ? 'CVs' : 'cover letters'}. Apply the user's request to the document. Keep it compilable with pdflatex and standard packages, and never invent facts beyond the candidate profile. Return {"latex": the full updated document, "reply": one or two sentences on what changed}.`,
    `Candidate profile:\n${profileText(await loadProfile(c.env.DB, c.get('userId')))}\n\n${job ? `Target job:\n${jobText(job)}\n\n` : ''}Current document:\n${doc.latex_content}\n\nRequest: ${message}`)
  return c.json(out)
})

app.post('/ai/generate/:applicationId', async (c) => {
  const kind = (await c.req.json()).kind
  const a = await loadApplication(c.env.DB, c.get('userId'), c.req.param('applicationId'))
  if (!a || !KINDS[kind]) return c.notFound()
  const what = kind === 'cvs' ? 'a one-page CV' : 'a cover letter'
  const { latex } = await ai(c.env,
    `Write ${what} in LaTeX tailored to the target job, using only facts from the candidate profile. Use this template's structure and packages:\n${TEMPLATES[kind]}\nReturn {"latex": the full document}.`,
    `Candidate profile:\n${profileText(await loadProfile(c.env.DB, c.get('userId')))}\n\nTarget job:\n${jobText(a)}`)
  const id = await createDoc(c.env.DB, c.get('userId'), kind, `${a.company} – ${a.position}`, latex)
  await c.env.DB.prepare(`UPDATE applications SET ${kind === 'cvs' ? 'cv_id' : 'cover_letter_id'} = ? WHERE id = ?`).bind(id, a.id).run()
  return c.json({ id })
})

app.post('/ai/answer/:applicationId/:qid', async (c) => {
  const a = await loadApplication(c.env.DB, c.get('userId'), c.req.param('applicationId'))
  const q = a?.questions.find((q) => q.id === c.req.param('qid'))
  if (!q) return c.notFound()
  const { answer } = await ai(c.env,
    'Answer this job application question in the first person as the candidate: concise, specific, honest, grounded only in the profile. Return {"answer": string}.',
    `Candidate profile:\n${profileText(await loadProfile(c.env.DB, c.get('userId')))}\n\nTarget job:\n${jobText(a)}\n\nQuestion: ${q.question}`)
  await c.env.DB.prepare('UPDATE application_questions SET answer = ?, ai_generated = 1 WHERE id = ?').bind(answer, q.id).run()
  return c.json({ answer })
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
