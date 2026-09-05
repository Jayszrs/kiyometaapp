import { createClient } from '../../../utils/supabase/api';

export default async function handler(req, res) {
  const supabase = createClient(req, res);
  await supabase.auth.signOut();

  if (req.method === 'GET') {
    res.redirect(302, '/login');
    return;
  }
  res.status(200).json({ ok: true });
}
