import fs from 'fs';
import path from 'path';
import { createClient } from '../utils/supabase/api';

const APP_HTML_PATH = path.join(
  process.cwd(),
  '..',
  'design',
  'stitch',
  'app.html'
);

// Cache the shell in production (it's a static file); always re-read in dev so
// edits show up on refresh.
let cachedHtml = null;
function readShell() {
  if (process.env.NODE_ENV === 'production') {
    if (!cachedHtml) cachedHtml = fs.readFileSync(APP_HTML_PATH, 'utf-8');
    return cachedHtml;
  }
  return fs.readFileSync(APP_HTML_PATH, 'utf-8');
}

// Remember once whether the optional `profiles` table exists, so we don't pay a
// failing round-trip on every request before 001_profiles.pgsql is run.
let profilesTableMissing = false;

// Serves the FactoryTrack tablet app with the signed-in user's identity and role
// injected as window.__FT_USER__.
export async function getServerSideProps({ req, res }) {
  const supabase = createClient(req, res);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { redirect: { destination: '/login', permanent: false } };
  }

  const meta = user.user_metadata || {};
  const appMeta = user.app_metadata || {};
  const valid = (r) => ['operator', 'gudang', 'admin'].includes(r);

  // app_metadata (not user-writable) is the source of truth. Only fall back to
  // the `profiles` table when nothing usable is on the user object.
  let role = valid(appMeta.role) ? appMeta.role : valid(meta.role) ? meta.role : null;
  let fullName = meta.full_name || null;
  let station = meta.station || null;

  if ((!role || !fullName || !station) && !profilesTableMissing) {
    const { data, error } = await supabase
      .from('profiles')
      .select('full_name, role, station')
      .eq('id', user.id)
      .maybeSingle();
    if (error && /schema cache|does not exist|PGRST205/i.test(error.message || error.code || '')) {
      profilesTableMissing = true;
    } else if (data) {
      role = valid(data.role) ? data.role : role;
      fullName = data.full_name || fullName;
      station = data.station || station;
    }
  }

  const ftUser = {
    id: user.id,
    email: user.email,
    fullName: fullName || user.email,
    role: valid(role) ? role : 'operator',
    station: station || 'LINE 02 · STASIUN W-04',
  };

  const inject =
    '<script>window.__FT_USER__=' +
    JSON.stringify(ftUser).replace(/</g, '\\u003c') +
    ';</script>\n';
  const html = readShell().replace('</head>', inject + '</head>');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(html);

  return { props: {} };
}

export default function Index() {
  return null;
}
