import { Suspense } from 'react';

import { WorkflowDetail } from './workflow-detail';

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // The detail view reads ?tab= to open on a given tab, which needs a
  // boundary for the prerender.
  return (
    <Suspense fallback={null}>
      <WorkflowDetail slug={decodeURIComponent(slug)} />
    </Suspense>
  );
}
