import { Suspense } from 'react';
import { BearclawMark } from '@/components/bearclaw-mark';
import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <header className="flex flex-col items-center space-y-3 text-center">
          <BearclawMark size={56} className="text-[color:var(--brand)]" />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">BearClaw</h1>
            <p className="text-sm text-[color:var(--muted)]">Sign in</p>
          </div>
        </header>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
