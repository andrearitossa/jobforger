import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function Auth({ mode, onAuth }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const isLogin = mode === 'login'
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    try {
      onAuth(await api(`/auth/${mode}`, { method: 'POST', body: form }))
      navigate('/')
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="auth">
      <form onSubmit={submit} className="stack">
        <div>
          <div className="brand">jobforger</div>
          <p className="muted">{isLogin ? 'Sign in to your account' : 'Create your account'}</p>
        </div>
        {!isLogin && <input placeholder="Name" value={form.name} onChange={set('name')} required />}
        <input type="email" placeholder="Email" value={form.email} onChange={set('email')} required />
        <input type="password" placeholder="Password" value={form.password} onChange={set('password')} minLength={isLogin ? 1 : 8} required />
        {error && <p className="error">{error}</p>}
        <button className="primary">{isLogin ? 'Sign in' : 'Create account'}</button>
        <p className="muted small">
          {isLogin ? <>No account? <Link to="/register">Create one</Link></> : <>Have an account? <Link to="/login">Sign in</Link></>}
        </p>
      </form>
    </div>
  )
}
