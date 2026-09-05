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

  // Prefer a `profiles` row (server/db/001_profiles.sql); fall back to the
  // values stored on the user at creation time so auth works before that
  // migration is run.
  let profile = null;
  try {
    const { data } = await supabase
      .from('profiles')
      .select('full_name, role, station')
      .eq('id', user.id)
      .maybeSingle();
    profile = data;
  } catch {
    // profiles table not set up yet
  }

  const meta = user.user_metadata || {};
  const appMeta = user.app_metadata || {};
  // app_metadata is not user-writable, so it wins over user_metadata.
  const role = profile?.role || appMeta.role || meta.role || 'operator';

  const ftUser = {
    id: user.id,
    email: user.email,
    fullName: profile?.full_name || meta.full_name || user.email,
    role: ['operator', 'gudang', 'admin'].includes(role) ? role : 'operator',
    station: profile?.station || meta.station || 'LINE 02 · STASIUN W-04',
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
