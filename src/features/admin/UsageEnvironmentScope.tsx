import { Layers } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Select } from '@/components/ui';
import { selectedUsageEnvironment, selectUsageEnvironment, type UsageEnvironment } from './usageAdmin';

const OPTIONS: { value: 'active' | UsageEnvironment; label: string }[] = [
  { value: 'active', label: 'Active environment (default)' },
  { value: 'main', label: 'Main' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'temporary', label: 'Temporary Public Testing' },
];

/**
 * Each API environment has its own AI allowances (settings, profiles, user limits and counters).
 * This bar picks which environment the usage pages below it manage; the page reloads its data
 * when the choice changes.
 */
export function UsageEnvironmentScope({ children }: { children: ReactNode }) {
  const [env, setEnv] = useState<'active' | UsageEnvironment>(() => selectedUsageEnvironment() ?? 'active');
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm sm:px-6">
        <Layers className="size-4 text-muted" aria-hidden="true" />
        <label htmlFor="usage-env" className="text-muted">
          API environment
        </label>
        <div className="w-60">
          <Select
            id="usage-env"
            value={env}
            options={OPTIONS}
            onChange={(v) => {
              selectUsageEnvironment(v === 'active' ? null : v);
              setEnv(v);
            }}
          />
        </div>
        <span className="text-xs text-muted">Limits and counters are separate in each environment.</span>
      </div>
      <div key={env} className="min-h-0 flex-1">
        {children}
      </div>
    </div>
  );
}
