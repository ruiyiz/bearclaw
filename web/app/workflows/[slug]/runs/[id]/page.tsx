import { RunView } from './run-view';

export default async function RunPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  return (
    <RunView slug={decodeURIComponent(slug)} runId={decodeURIComponent(id)} />
  );
}
