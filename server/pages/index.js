export default function Home() {
  const screens = [
    { id: 1, title: 'Home Dashboard', path: '/screens/1' },
    { id: 2, title: 'Scan Job', path: '/screens/2' },
    { id: 3, title: 'Production Progress', path: '/screens/3' },
    { id: 4, title: 'Scan Material Issue', path: '/screens/4' },
  ];

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', padding: '40px', background: '#f8f9ff', minHeight: '100vh' }}>
      <h1 style={{ color: '#0b1c30', marginBottom: '30px' }}>FactoryTrack MES — Screen Selector</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px' }}>
        {screens.map((screen) => (
          <a
            key={screen.id}
            href={screen.path}
            style={{
              display: 'block',
              padding: '24px',
              background: '#fff',
              border: '1px solid #d3e4fe',
              borderRadius: '8px',
              textDecoration: 'none',
              color: '#0b1c30',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
              e.currentTarget.style.transform = 'translateY(-2px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <h2 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: '600' }}>
              Screen {screen.id} — {screen.title}
            </h2>
            <p style={{ margin: 0, color: '#434655', fontSize: '14px' }}>
              Click to open
            </p>
          </a>
        ))}
      </div>

      <div style={{ marginTop: '40px', padding: '20px', background: '#e5eeff', borderRadius: '8px', borderLeft: '4px solid #0037b0' }}>
        <h3 style={{ margin: '0 0 8px 0', color: '#0037b0' }}>API Endpoints</h3>
        <ul style={{ margin: 0, padding: '0 0 0 20px', color: '#434655', fontSize: '14px' }}>
          <li><code>/api/jobs</code> — List/create jobs</li>
          <li><code>/api/materials</code> — Material lot tracking</li>
          <li><code>/api/issues</code> — Issue reports</li>
        </ul>
      </div>
    </div>
  );
}
