import fs from 'fs';
import path from 'path';
import { createClient } from '../utils/supabase/api';

// Serves the FactoryTrack tablet app (design/stitch/app.html) with the signed-in
// user's identity and role injected as window.__FT_USER__.
export async function getServerSideProps({ req, res }) {
  const supabase = createClient(req, res);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { redirect: { destination: '/login', permanent: false } };
  }

  let profile = null;
  try {
    const { data } = await supabase
      .from('profiles')
      .select('full_name, role, station')
      .eq('id', user.id)
      .maybeSingle();
    profile = data;
  } catch {
    // profiles table not set up yet — fall back to defaults below
  }

  const ftUser = {
    id: user.id,
    email: user.email,
    fullName: profile?.full_name || user.email,
    role: profile?.role || 'operator',
    station: profile?.station || 'LINE 02 · STASIUN W-04',
  };

  const filePath = path.join(process.cwd(), '..', 'design', 'stitch', 'app.html');
  let html = fs.readFileSync(filePath, 'utf-8');

  const inject =
    '<script>window.__FT_USER__=' +
    JSON.stringify(ftUser).replace(/</g, '\\u003c') +
    ';</script>';
  html = html.replace('</head>', inject + '\n</head>');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(html);

  return { props: {} };
}

export default function Index() {
  return null;
}
