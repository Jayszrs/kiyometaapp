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
      const { status } = req.query;

      let query = supabase.from('issues').select('*');

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query.order('created_at', {
        ascending: false,
      });

      if (error) throw error;
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const {
        lot_id,
        issue_type,
        severity,
        affected_qty,
        notes,
        operator_id,
      } = req.body;

      const { data, error } = await supabase
        .from('issues')
        .insert([
          {
            lot_id,
            issue_type,
            severity,
            affected_qty,
            notes,
            operator_id,
            status: 'REPORTED',
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
