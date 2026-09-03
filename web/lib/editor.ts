'use client';

import { useEffect, useState } from 'react';

// Which palette is actually on screen: the explicit choice if there is one,
// otherwise what the system asks for.
export function useResolvedTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    const compute = (): 'dark' | 'light' => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'dark' || attr === 'light') return attr;
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    };
    setTheme(compute());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => setTheme(compute());
    mq.addEventListener('change', onMq);
    const obs = new MutationObserver(() => setTheme(compute()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      mq.removeEventListener('change', onMq);
      obs.disconnect();
    };
  }, []);
  return theme;
}
