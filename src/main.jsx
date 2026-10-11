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
import './styles.css'

function Shell({ user, setUser, children }) {
  const navigate = useNavigate()
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' })
    setUser(null)
    navigate('/login')
  }
  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">jobforger</NavLink>
        <nav>
          <NavLink to="/" end>Applications</NavLink>
          <NavLink to="/cvs">CVs</NavLink>
          <NavLink to="/cover-letters">Cover letters</NavLink>
          <NavLink to="/profile">Profile</NavLink>
        </nav>
        <button className="ghost" onClick={logout} title={user.email}>Sign out</button>
      </header>
      <main>{children}</main>
    </>
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
