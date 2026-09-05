import { createClient } from '../../utils/supabase/api';

export default async function handler(req, res) {
  const supabase = createClient(req, res);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    if (req.method === 'GET') {
      const { lot_id } = req.query;

      let query = supabase.from('materials').select('*');
      if (lot_id) query = query.eq('lot_id', lot_id);

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
