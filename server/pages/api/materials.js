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
      const { lot_id } = req.query;

      let query = supabase.from('materials').select('*');

      if (lot_id) {
        query = query.eq('lot_id', lot_id);
      }

      const { data, error } = await query.order('received_date', {
        ascending: false,
      });

      if (error) throw error;
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const { lot_id, material_name, supplier, qty, received_date } = req.body;

      const { data, error } = await supabase
        .from('materials')
        .insert([
          {
            lot_id,
            material_name,
            supplier,
            qty,
            received_date,
            status: 'IN_STOCK',
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
