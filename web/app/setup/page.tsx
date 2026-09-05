import { BearclawMark } from '@/components/bearclaw-mark';
import { SetupWizard } from './setup-wizard';

export const metadata = { title: 'Set up BearClaw' };

export default function SetupPage() {
  return (
    <main className="flex-1 overflow-y-auto px-6 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="flex flex-col items-center space-y-3 text-center">
          <BearclawMark size={56} className="text-[color:var(--brand)]" />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">BearClaw</h1>
            <p className="text-sm text-[color:var(--muted)]">
              First run. A few questions and you are done.
            </p>
          </div>
        </header>
        <SetupWizard />
      </div>
    </main>
  );
}
