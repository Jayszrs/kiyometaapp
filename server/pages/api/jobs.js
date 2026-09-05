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
        order_no,
        product_type,
        operation_type,
        route,
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
      const optional = { order_no, product_type, operation_type, route };
      for (const [k, v] of Object.entries(optional)) {
        if (v !== undefined) record[k] = v;
      }

      let { data, error } = await supabase
        .from('jobs')
        .upsert([record], { onConflict: 'job_id' })
        .select();

      // If server/db/002_jobs_columns.sql hasn't been run yet, retry without
      // the columns that don't exist so the core job still saves.
      let warning;
      if (error && /column .* does not exist|Could not find the '.*' column/i.test(error.message || '')) {
        for (const k of Object.keys(optional)) delete record[k];
        warning =
          'Kolom order/rute belum ada — jalankan server/db/002_jobs_columns.sql. Job inti tetap tersimpan.';
        ({ data, error } = await supabase
          .from('jobs')
          .upsert([record], { onConflict: 'job_id' })
          .select());
      }

      if (error) throw error;
      return res.status(201).json({ data, warning });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
