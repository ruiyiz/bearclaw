import { EventsView } from './events-view';
import { Nav } from '@/components/Nav';

export default function EventsPage() {
  return (
    <>
      <Nav
        base="NanoClaw"
        items={[
          { href: '/chat', label: 'Chat' },
          { href: '/events', label: 'Events' },
          { href: '/admin', label: 'Admin' },
        ]}
      />
      <EventsView />
    </>
  );
}
