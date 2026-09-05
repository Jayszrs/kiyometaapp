import { useRouter } from 'next/router';
import fs from 'fs';
import path from 'path';

const screens = {
  1: 'screen-1-home-dashboard.html',
  2: 'screen-2-scan-job.html',
  3: 'screen-3-production-progress.html',
  4: 'screen-4-scan-material-issue.html',
};

export default function Screen({ htmlContent }) {
  const router = useRouter();

  if (router.isFallback) {
    return <div>Loading...</div>;
  }

  return <div dangerouslySetInnerHTML={{ __html: htmlContent }} />;
}

export async function getStaticProps({ params }) {
  const screenId = params.id;
  const filename = screens[screenId];

  if (!filename) {
    return { notFound: true };
  }

  const filePath = path.join(process.cwd(), '..', 'design', 'stitch', filename);

  try {
    const htmlContent = fs.readFileSync(filePath, 'utf-8');
    return {
      props: { htmlContent },
      revalidate: 60,
    };
  } catch (error) {
    console.error(`Failed to read ${filename}:`, error);
    return { notFound: true };
  }
}

export async function getStaticPaths() {
  return {
    paths: [
      { params: { id: '1' } },
      { params: { id: '2' } },
      { params: { id: '3' } },
      { params: { id: '4' } },
    ],
    fallback: false,
  };
}
