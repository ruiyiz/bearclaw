import { AppShell } from '@/components/app-shell';
import { RouteTitle } from '@/components/route-title';

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AppShell bare>
      <RouteTitle fallback="Chat" />
      {children}
    </AppShell>
  );
}
