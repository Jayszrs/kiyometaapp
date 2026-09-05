import { createClient, admin } from '../../utils/supabase/api';

export default async function handler(req, res) {
  const {
    data: { user },
  } = await createClient(req, res).auth.getUser();

  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const supabase = admin;

  try {
    if (req.method === 'GET') {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const { data, error } = await supabase
        .from('job_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      // job_events table not created yet — return empty rather than 500.
      if (error) {
        if (/schema cache|does not exist|PGRST205/i.test(error.message || error.code || '')) {
          return res.status(200).json({ data: [], warning: 'job_events belum ada' });
        }
        throw error;
      }
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const { job_id, event, operator, qty } = req.body;
      if (!job_id || !event) {
        return res.status(400).json({ error: 'job_id and event are required' });
      }

      const { data, error } = await supabase
        .from('job_events')
        .insert([{ job_id, event, operator: operator || null, qty: qty ?? null }])
        .select();

      if (error) {
        if (/schema cache|does not exist|PGRST205/i.test(error.message || error.code || '')) {
          return res.status(202).json({ data: [], warning: 'job_events belum ada' });
        }
        throw error;
      }
      return res.status(201).json({ data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
