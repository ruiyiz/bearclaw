import { WorkflowDetail } from './workflow-detail';

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <WorkflowDetail slug={decodeURIComponent(slug)} />;
}
