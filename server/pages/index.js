import fs from 'fs';
import path from 'path';

// Serves the unified FactoryTrack MES tablet app (single-page, all views in one shell).
export async function getServerSideProps({ res }) {
  const filePath = path.join(process.cwd(), '..', 'design', 'stitch', 'app.html');
  const html = fs.readFileSync(filePath, 'utf-8');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(html);

  return { props: {} };
}

export default function Index() {
  return null;
}
