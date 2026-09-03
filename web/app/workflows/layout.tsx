import { AppShell } from '@/components/app-shell';

export default function WorkflowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
