import { createContext, useContext, type ReactNode } from 'react';

/** Building blocks shared by the settings pages. */

/** Title of the open sub-page; a group with the same title does not repeat it. */
export const PageTitle = createContext('');

export function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:min-h-12 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-[15px]">{title}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="shrink-0 sm:max-w-[60%]">{children}</div>
    </div>
  );
}

/** Grouped, inset list section: small header above a rounded card. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const page = useContext(PageTitle);
  return (
    <section className="mb-7">
      {title !== page && (
        <h2 className="mb-1.5 px-4 text-[13px] font-medium text-muted">{title}</h2>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-2xl bg-elevated [&>*]:px-4">
        {children}
      </div>
    </section>
  );
}

export function providerLabel(id: string) {
  return id === 'google.com'
    ? 'Google'
    : id === 'apple.com'
      ? 'Apple'
      : id === 'password'
        ? 'Email and password'
        : id;
}
export const maskPhone = (p: string) =>
  p.length > 8 ? `${p.slice(0, 4)} ${'\u2022'.repeat(p.length - 8)} ${p.slice(-4)}` : p;
