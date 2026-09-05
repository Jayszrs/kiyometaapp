import { createClient } from '@supabase/supabase-js';

const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
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
      const { job_id, customer, product, qty_target } = req.body;

      const { data, error } = await supabase
        .from('jobs')
        .insert([
          {
            job_id,
            customer,
            product,
            qty_target,
            status: 'READY',
          },
        ])
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
