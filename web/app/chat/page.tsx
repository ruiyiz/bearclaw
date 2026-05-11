import { ChatView } from './chat-view';
import { Nav } from '@/components/Nav';

export default function ChatPage() {
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
      <ChatView />
    </>
  );
}
