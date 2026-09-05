import { useState } from 'react';
import { useRouter } from 'next/router';
import { createClient } from '../utils/supabase/component';

function Icon({ d, size = 18, children, stroke = 2 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flex: 'none' }}
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(
        /invalid login/i.test(error.message)
          ? 'Email atau kata sandi salah.'
          : error.message || 'Gagal masuk.'
      );
      setBusy(false);
      return;
    }
    const next =
      typeof router.query.next === 'string' && router.query.next.startsWith('/')
        ? router.query.next
        : '/';
    // Full-page navigation (not router.replace): the app shell at "/" is streamed
    // straight from getServerSideProps, so a client-side transition would hang.
    window.location.assign(next);
  }

  return (
    <div style={S.page} className="ft-login">
      <style dangerouslySetInnerHTML={{ __html: GLOBAL }} />

      {/* LEFT — brand panel */}
      <div style={S.left} className="ft-login-left">
        <div style={S.leftInner}>
          <div style={S.logo}>
            <div style={S.logoName}>FactoryTrack</div>
            <div style={S.logoSub}>ONESMARTSERVICES</div>
          </div>

          <div>
            <div style={S.eyebrow}>MES LANTAI PRODUKSI</div>
            <h1 style={S.hero}>
              Satu scan,
              <br />
              satu aliran kerja.
            </h1>
            <p style={S.heroSub}>
              Masuk untuk menjalankan job, meng-issue material, dan memantau
              progres stasiun secara real-time — tanpa kertas, tanpa input manual.
            </p>
            <ul style={S.bullets}>
              {[
                'Data job & material dari master data',
                'Akses menu sesuai peran',
                'Jam mulai / selesai tercatat otomatis',
              ].map((t) => (
                <li key={t} style={S.bullet}>
                  <span style={S.bulletDot}>
                    <Icon d="M20 6 9 17l-5-5" size={12} stroke={3} />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div style={S.leftFoot}>© 2026 OneSmartServices · FactoryTrack MES</div>
        </div>
        <div style={S.leftGrid} aria-hidden />
      </div>

      {/* RIGHT — form */}
      <div style={S.right}>
        <div style={S.form}>
          <div style={S.eyebrowDark}>PORTAL STASIUN</div>
          <h2 style={S.h2}>Masuk ke stasiun</h2>
          <p style={S.sub}>
            Gunakan akun operator, gudang, atau admin dari supervisor.
          </p>

          <form onSubmit={onSubmit} style={{ display: 'contents' }}>
            <label style={S.label}>EMAIL</label>
            <div style={S.field}>
              <span style={S.fieldIcon}>
                <Icon size={17}>
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </Icon>
              </span>
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={S.input}
                placeholder="nama@perusahaan.co.id"
              />
            </div>

            <label style={S.label}>KATA SANDI</label>
            <div style={S.field}>
              <span style={S.fieldIcon}>
                <Icon size={17}>
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </Icon>
              </span>
              <input
                type={show ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ ...S.input, paddingRight: 44 }}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                style={S.eye}
                aria-label={show ? 'Sembunyikan sandi' : 'Tampilkan sandi'}
              >
                {show ? (
                  <Icon size={17}>
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                    <line x1="2" x2="22" y1="2" y2="22" />
                  </Icon>
                ) : (
                  <Icon size={17}>
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </Icon>
                )}
              </button>
            </div>

            <div style={S.forgot}>Lupa kata sandi? Hubungi supervisor.</div>

            {error ? <div style={S.error}>{error}</div> : null}

            <button type="submit" disabled={busy} style={S.button}>
              {busy ? 'Memeriksa…' : 'Masuk ke dashboard'}
              {!busy && <Icon d="M5 12h14 M12 5l7 7-7 7" size={17} />}
            </button>
          </form>

          <div style={S.foot}>
            Akun dibuat admin di Supabase → Authentication → Users.
          </div>
        </div>
      </div>
    </div>
  );
}

const GLOBAL = `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;height:100%}
  body{background:#1c1a17;font-family:'Inter',system-ui,-apple-system,sans-serif;color:#3a352f}
  input::placeholder{color:#b3aca1}
  input:focus{outline:none;border-color:#8a5a3c !important;background:#fff !important}
  button[type=submit]:hover{background:#764a30}
  button[type=submit]:disabled{opacity:.6;cursor:default}
  @media (max-width:860px){
    .ft-login{flex-direction:column}
    .ft-login-left{display:none}
  }
`;

const BROWN = '#8a5a3c';

const S = {
  page: { display: 'flex', minHeight: '100vh', minHeight: '100dvh' },

  left: {
    position: 'relative',
    flex: '1 1 52%',
    display: 'flex',
    color: '#fff',
    padding: '56px 60px',
    background:
      'linear-gradient(150deg, #2a1c12 0%, #3d2817 42%, #5a3a24 100%)',
    overflow: 'hidden',
  },
  leftInner: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 40,
    maxWidth: 460,
  },
  leftGrid: {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px)',
    backgroundSize: '44px 44px',
    maskImage: 'radial-gradient(120% 120% at 100% 0%, #000 20%, transparent 70%)',
    WebkitMaskImage:
      'radial-gradient(120% 120% at 100% 0%, #000 20%, transparent 70%)',
  },
  logo: {
    alignSelf: 'flex-start',
    background: '#fff',
    borderRadius: 6,
    padding: '8px 12px',
  },
  logoName: {
    font: "600 16px/1.1 'Inter',sans-serif",
    letterSpacing: '-.011em',
    color: '#1c1a17',
  },
  logoSub: {
    font: "400 9px/1.3 'JetBrains Mono',monospace",
    letterSpacing: '.16em',
    color: '#8a8177',
    marginTop: 2,
  },
  eyebrow: {
    font: "600 11px/1 'JetBrains Mono',monospace",
    letterSpacing: '.18em',
    color: '#e0b48f',
    marginBottom: 18,
  },
  hero: {
    font: "700 40px/1.12 'Inter',sans-serif",
    letterSpacing: '-.02em',
    margin: '0 0 16px',
  },
  heroSub: {
    font: "400 14px/1.6 'Inter',sans-serif",
    color: 'rgba(255,255,255,.72)',
    margin: '0 0 26px',
    maxWidth: 400,
  },
  bullets: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 },
  bullet: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    font: "500 13.5px/1.3 'Inter',sans-serif",
    color: 'rgba(255,255,255,.9)',
  },
  bulletDot: {
    width: 22,
    height: 22,
    flex: 'none',
    borderRadius: 999,
    background: 'rgba(224,180,143,.18)',
    color: '#e0b48f',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  leftFoot: {
    font: "400 11px/1.4 'JetBrains Mono',monospace",
    letterSpacing: '.04em',
    color: 'rgba(255,255,255,.4)',
  },

  right: {
    flex: '1 1 48%',
    background: '#faf9f6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 40px',
  },
  form: { width: 400, maxWidth: '100%', display: 'flex', flexDirection: 'column' },
  eyebrowDark: {
    font: "600 11px/1 'JetBrains Mono',monospace",
    letterSpacing: '.18em',
    color: BROWN,
    marginBottom: 14,
  },
  h2: {
    font: "600 26px/1.15 'Inter',sans-serif",
    letterSpacing: '-.015em',
    color: '#201e1a',
    margin: '0 0 8px',
  },
  sub: {
    font: "400 13.5px/1.5 'Inter',sans-serif",
    color: '#7a7268',
    margin: '0 0 28px',
  },
  label: {
    font: "600 11px/1 'JetBrains Mono',monospace",
    letterSpacing: '.1em',
    color: '#7a7268',
    marginBottom: 8,
  },
  field: { position: 'relative', marginBottom: 16 },
  fieldIcon: {
    position: 'absolute',
    left: 14,
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#a8a096',
    pointerEvents: 'none',
  },
  input: {
    width: '100%',
    height: 50,
    border: '1px solid #ddd6ca',
    borderRadius: 9,
    padding: '0 14px 0 42px',
    font: "400 15px/1 'Inter',sans-serif",
    color: '#201e1a',
    background: '#fff',
    transition: 'border-color .12s, background .12s',
  },
  eye: {
    position: 'absolute',
    right: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 0,
    background: 'transparent',
    color: '#8a8177',
    cursor: 'pointer',
    borderRadius: 6,
  },
  forgot: {
    font: "400 12px/1.4 'Inter',sans-serif",
    color: '#9a9288',
    textAlign: 'right',
    marginBottom: 18,
  },
  error: {
    background: '#fdf0ee',
    border: '1px solid #f2c7bd',
    borderLeft: '2px solid #c0392b',
    borderRadius: 6,
    padding: '10px 12px',
    font: "400 12.5px/1.4 'Inter',sans-serif",
    color: '#a12f22',
    marginBottom: 16,
  },
  button: {
    height: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    border: '1px solid transparent',
    borderRadius: 9,
    background: BROWN,
    color: '#fff',
    font: "600 15px/1 'Inter',sans-serif",
    letterSpacing: '.01em',
    cursor: 'pointer',
  },
  foot: {
    marginTop: 22,
    paddingTop: 18,
    borderTop: '1px solid #eae4da',
    font: "400 11.5px/1.5 'Inter',sans-serif",
    color: '#9a9288',
  },
};
