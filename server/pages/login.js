import { useState } from 'react';
import { useRouter } from 'next/router';
import { createClient } from '../utils/supabase/component';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message || 'Gagal masuk. Periksa email dan kata sandi.');
      setBusy(false);
      return;
    }
    const next =
      typeof router.query.next === 'string' && router.query.next.startsWith('/')
        ? router.query.next
        : '/';
    router.replace(next);
  }

  return (
    <div style={S.stage}>
      <style>{GLOBAL}</style>
      <div style={S.card}>
        <div style={S.brandRow}>
          <div style={S.logo}>
            <div style={S.logoName}>FactoryTrack</div>
            <div style={S.logoSub}>ONESMARTSERVICES</div>
          </div>
        </div>

        <h1 style={S.h1}>Masuk stasiun</h1>
        <p style={S.sub}>
          Gunakan akun operator, gudang, atau admin yang diberikan supervisor.
        </p>

        <form onSubmit={onSubmit} style={S.form}>
          <label style={S.label}>
            Email
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={S.input}
              placeholder="nama@perusahaan.co.id"
            />
          </label>
          <label style={S.label}>
            Kata sandi
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={S.input}
              placeholder="••••••••"
            />
          </label>

          {error ? <div style={S.error}>{error}</div> : null}

          <button type="submit" disabled={busy} style={S.button}>
            {busy ? 'Memeriksa…' : 'Masuk'}
          </button>
        </form>

        <div style={S.foot}>
          Akun dibuat oleh admin di Supabase → Authentication → Users.
        </div>
      </div>
    </div>
  );
}

const GLOBAL = `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:#edeae4;font-family:'Inter',system-ui,-apple-system,sans-serif;color:#3a352f}
`;

const S = {
  stage: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background:
      'radial-gradient(1200px 600px at 50% -10%, #f6f4f0, #e6e2da)',
  },
  card: {
    width: 420,
    maxWidth: '100%',
    background: '#fff',
    border: '1px solid #cec7bb',
    borderRadius: 12,
    boxShadow: '0 14px 40px rgba(30,25,18,.14)',
    padding: '32px 32px 24px',
  },
  brandRow: { display: 'flex', alignItems: 'center', marginBottom: 22 },
  logo: {
    background: '#1c1a17',
    borderRadius: 6,
    padding: '8px 12px',
  },
  logoName: {
    font: "600 16px/1.1 'Inter',sans-serif",
    letterSpacing: '-.011em',
    color: '#fff',
  },
  logoSub: {
    font: "400 9px/1.3 'JetBrains Mono',monospace",
    letterSpacing: '.14em',
    color: '#8a8177',
    marginTop: 2,
  },
  h1: {
    font: "600 22px/1.2 'Inter',sans-serif",
    letterSpacing: '-.011em',
    color: '#201e1a',
    margin: '0 0 6px',
  },
  sub: { font: "400 13px/1.5 'Inter',sans-serif", color: '#7a7268', margin: '0 0 22px' },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    font: "500 12px/1.2 'Inter',sans-serif",
    color: '#7a7268',
  },
  input: {
    height: 46,
    border: '1px solid #ddd6ca',
    borderRadius: 8,
    padding: '0 14px',
    font: "400 15px/1 'Inter',sans-serif",
    color: '#201e1a',
    outline: 'none',
    background: '#fff',
  },
  error: {
    background: '#fdf0ee',
    border: '1px solid #f2c7bd',
    borderLeft: '2px solid #c0392b',
    borderRadius: 6,
    padding: '10px 12px',
    font: "400 12.5px/1.4 'Inter',sans-serif",
    color: '#a12f22',
  },
  button: {
    height: 48,
    marginTop: 4,
    border: '1px solid transparent',
    borderRadius: 8,
    background: '#8a5a3c',
    color: '#fff',
    font: "500 15px/1 'Inter',sans-serif",
    cursor: 'pointer',
  },
  foot: {
    marginTop: 20,
    paddingTop: 16,
    borderTop: '1px solid #eae4da',
    font: "400 11.5px/1.5 'Inter',sans-serif",
    color: '#9a9288',
  },
};
