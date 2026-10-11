import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom'
import { api } from './api'
import Auth from './pages/Auth'
import Applications from './pages/Applications'
import Application from './pages/Application'
import Docs from './pages/Docs'
import DocEditor from './pages/DocEditor'
import Profile from './pages/Profile'
import Copilot from './Copilot'
import './styles.css'

function Shell({ user, setUser, children }) {
  const navigate = useNavigate()
  const [copilot, setCopilot] = useState(() => { try { return localStorage.getItem('copilot:open') !== '0' } catch { return true } })
  useEffect(() => { try { localStorage.setItem('copilot:open', copilot ? '1' : '0') } catch {} }, [copilot])
  useEffect(() => {
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setCopilot((o) => !o) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' })
    setUser(null)
    navigate('/login')
  }
  return (
    <div className={copilot ? 'with-copilot' : ''}>
      <header className="topbar">
        <NavLink to="/" className="brand">jobforger</NavLink>
        <nav>
          <NavLink to="/" end>Applications</NavLink>
          <NavLink to="/cvs">CVs</NavLink>
          <NavLink to="/cover-letters">Cover letters</NavLink>
          <NavLink to="/profile">Profile</NavLink>
        </nav>
        <button className="ghost" onClick={logout} title={user.email}>Sign out</button>
        <button className={`copilot-toggle ${copilot ? 'on' : ''}`} onClick={() => setCopilot(!copilot)} title="Ctrl+K">✦ Copilot</button>
      </header>
      <main>{children}</main>
      <Copilot user={user} open={copilot} onClose={() => setCopilot(false)} />
    </div>
  )
}

function App() {
  const [user, setUser] = useState(undefined)
  useEffect(() => { api('/auth/me').then(setUser).catch(() => setUser(null)) }, [])
  if (user === undefined) return null
  if (!user) {
    return (
      <Routes>
        <Route path="/register" element={<Auth mode="register" onAuth={setUser} />} />
        <Route path="*" element={<Auth mode="login" onAuth={setUser} />} />
      </Routes>
    )
  }
  return (
    <Shell user={user} setUser={setUser}>
      <Routes>
        <Route path="/" element={<Applications />} />
        <Route path="/applications/:id" element={<Application />} />
        <Route path="/cvs" element={<Docs kind="cvs" />} />
        <Route path="/cover-letters" element={<Docs kind="cover-letters" />} />
        <Route path="/cvs/:id" element={<DocEditor kind="cvs" />} />
        <Route path="/cover-letters/:id" element={<DocEditor kind="cover-letters" />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Shell>
  )
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>)
