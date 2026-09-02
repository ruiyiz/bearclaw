import { ModuleNav } from '@/components/module-nav';

export default function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ModuleNav base="Inbox" />
      <main className="flex-1 px-3 py-3 overflow-y-auto">{children}</main>
    </>
  );
}
