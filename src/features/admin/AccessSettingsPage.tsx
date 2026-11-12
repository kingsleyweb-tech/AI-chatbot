import { Page } from '../shell/Page';
import { AccessSection } from '../settings/SettingsPage';

/** Access and registration inside the Admin Dashboard (the same settings as /settings/access). */
export default function AccessSettingsPage() {
  return (
    <Page title="Access and registration" wide>
      <div className="max-w-2xl">
        <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Access and registration</h1>
        <p className="mb-6 text-sm text-muted">Who can sign up, automatic approval and phone verification.</p>
        <AccessSection />
      </div>
    </Page>
  );
}
