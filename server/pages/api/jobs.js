import { createClient } from '@supabase/supabase-js';

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase =
  process.env.NEXT_PUBLIC_SUPABASE_URL && supabaseKey
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, supabaseKey)
    : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const {
        job_id,
        customer,
        product,
        qty_target,
        qty_completed,
        status,
      } = req.body;

      if (!job_id) {
        return res.status(400).json({ error: 'job_id is required' });
      }

      // Upsert on job_id so START / CONTINUE / FINISH update the same row.
      const record = {
        job_id,
        customer,
        product,
        qty_target,
        status: status || 'READY',
        updated_at: new Date().toISOString(),
      };
      if (qty_completed != null) record.qty_completed = qty_completed;

      const { data, error } = await supabase
        .from('jobs')
        .upsert([record], { onConflict: 'job_id' })
        .select();

      if (error) throw error;
      return res.status(201).json({ data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
