import { redirect } from 'next/navigation';

// Open human steps live with the runs they belong to now: the Workflows list
// carries the band, the run view carries the step. The route stays so old
// links and the installed PWA shortcut still land somewhere useful.
export default function InboxPage() {
  redirect('/workflows');
}
