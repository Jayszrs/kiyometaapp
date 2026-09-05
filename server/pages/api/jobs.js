import { createClient, admin } from '../../utils/supabase/api';

const COLUMN_MISSING =
  /column .* does not exist|Could not find the '.*' column|schema cache/i;

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
        steps,
      } = req.body;

      if (!job_id) {
        return res.status(400).json({ error: 'job_id is required' });
      }

      // Only write the fields that were actually sent (partial updates must not
      // null out customer/product/route/etc).
      const base = { updated_at: new Date().toISOString() };
      const maybe = {
        customer,
        product,
        qty_target,
        qty_completed,
        status,
        order_no,
        product_type,
        operation_type,
        route,
        steps,
      };
      for (const [k, v] of Object.entries(maybe)) {
        if (v !== undefined) base[k] = v;
      }

      const { data: existing } = await supabase
        .from('jobs')
        .select('job_id')
        .eq('job_id', job_id)
        .maybeSingle();

      const run = (rec) =>
        existing
          ? supabase.from('jobs').update(rec).eq('job_id', job_id).select()
          : supabase
              .from('jobs')
              .insert([{ job_id, status: status || 'READY', ...rec }])
              .select();

      let { data, error } = await run(base);

      // Retry without columns that don't exist yet (002/003 not run).
      let warning;
      if (error && COLUMN_MISSING.test(error.message || '')) {
        const trimmed = { ...base };
        for (const k of ['order_no', 'product_type', 'operation_type', 'route', 'steps']) {
          delete trimmed[k];
        }
        warning =
          'Sebagian kolom belum ada — jalankan server/db/002_jobs_columns.pgsql & 003_steps_and_events.pgsql. Data inti tetap tersimpan.';
        ({ data, error } = await run(trimmed));
      }

      if (error) throw error;
      return res.status(existing ? 200 : 201).json({ data, warning });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
