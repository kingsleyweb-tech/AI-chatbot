import { CheckCircle2, Info } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input, Label, Select } from '@/components/ui';
import { useAuth } from '@/state/auth';
import { SUPPORT_CATEGORIES, SUPPORT_LIMITS, type SupportCategory } from '@shared/support';
import { Page } from '../shell/Page';
import { submissionId, supportApi, type NewAttachment } from './api';
import { Counter, errorText, ScreenshotPicker } from './parts';

export default function ReportIssuePage() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [category, setCategory] = useState<SupportCategory | ''>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<NewAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // One id per filled-in form: a double tap or a retry returns the same report.
  const sid = useRef(submissionId());

  const problems = {
    category: !category ? 'Choose a category.' : null,
    title: title.trim().length < 3 ? 'Add a short title (at least 3 characters).' : title.length > SUPPORT_LIMITS.title ? `Keep the title under ${SUPPORT_LIMITS.title} characters.` : null,
    description:
      description.trim().length < 10 ? 'Describe what happened (at least 10 characters).' : description.length > SUPPORT_LIMITS.description ? `Keep the description under ${SUPPORT_LIMITS.description} characters.` : null,
  };
  const valid = !problems.category && !problems.title && !problems.description;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await supportApi.create({ title: title.trim(), category: category as SupportCategory, description: description.trim(), attachments: files, submissionId: sid.current });
      setDone(r.ref);
    } catch (err) {
      setError(errorText(err, 'Your report could not be sent. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Page title="Report sent" back="/settings">
        <div className="mx-auto flex max-w-md flex-col items-center py-10 text-center">
          <CheckCircle2 className="size-12 text-accent" strokeWidth={1.5} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Thanks, your report was sent</h1>
          <p className="mt-2 text-sm text-muted">Your reference number is</p>
          <p className="mt-1 font-mono text-lg font-semibold tracking-wide select-all">{done}</p>
          <p className="mt-3 text-sm text-muted">You’ll get a notification in Atlas AI when Atlas Support replies or the status changes.</p>
          <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row">
            <Button className="flex-1" onClick={() => navigate(`/support/${done}`)}>
              View report
            </Button>
            <Button className="flex-1" variant="secondary" onClick={() => navigate('/settings')}>
              Done
            </Button>
          </div>
        </div>
      </Page>
    );
  }

  const name = profile?.displayName || user?.displayName || user?.email?.split('@')[0] || '';
  return (
    <Page title="Report an issue" back="/settings">
      <form onSubmit={(e) => void submit(e)} className="mx-auto max-w-xl" noValidate>
        <h1 className="mb-1 hidden text-xl font-semibold tracking-tight lg:block">Report an issue</h1>
        <p className="mb-6 text-sm text-muted">
          Tell us what went wrong or what you’d like to see. Check the{' '}
          <Link to="/help" className="text-accent underline-offset-2 hover:underline">
            Help Centre
          </Link>{' '}
          for quick answers.
        </p>

        <div className="space-y-5">
          <div>
            <Label htmlFor="report-category">Category</Label>
            <Select<SupportCategory | ''>
              id="report-category"
              value={category}
              onChange={setCategory}
              options={[{ value: '', label: 'Choose a category' }, ...SUPPORT_CATEGORIES.map((c) => ({ value: c.id as SupportCategory, label: c.label }))]}
            />
            {touched && problems.category && <p className="mt-1 text-xs text-danger">{problems.category}</p>}
          </div>

          <div>
            <Label htmlFor="report-title">Title</Label>
            <Input id="report-title" value={title} maxLength={SUPPORT_LIMITS.title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: PDF upload never finishes" autoComplete="off" />
            {touched && problems.title && <p className="mt-1 text-xs text-danger">{problems.title}</p>}
          </div>

          <div>
            <Label htmlFor="report-description">What happened?</Label>
            <div className="rounded-[14px] border border-border bg-bg transition-colors focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
              <textarea
                id="report-description"
                rows={7}
                maxLength={SUPPORT_LIMITS.description}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the steps, what you expected and what happened instead."
                className="block w-full resize-none rounded-[14px] bg-transparent px-3.5 pt-3 text-sm text-fg placeholder:text-subtle focus:outline-none"
              />
              <div className="flex justify-end px-3.5 pb-2.5">
                <Counter n={description.length} max={SUPPORT_LIMITS.description} />
              </div>
            </div>
            {touched && problems.description && <p className="mt-1 text-xs text-danger">{problems.description}</p>}
          </div>

          <div>
            <Label hint={`Optional. Up to ${SUPPORT_LIMITS.attachments} images, 10 MB each. Images are compressed before upload.`}>Screenshots</Label>
            <ScreenshotPicker value={files} onChange={setFiles} disabled={busy} />
          </div>

          <div className="flex gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-xs text-muted">
            <Info className="mt-px size-4 shrink-0" />
            <p>
              Your report includes your name{name ? ` (${name})` : ''}, your email address ({user?.email}) and anything you attach, so Atlas Support can reply. Don’t include passwords or verification codes. See the{' '}
              <Link to="/privacy" className="underline underline-offset-2">
                Privacy Policy
              </Link>
              .
            </p>
          </div>

          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="w-full" loading={busy} disabled={busy}>
            Send report
          </Button>
          <p className="text-center text-sm">
            <Link to="/support" className="text-accent underline-offset-2 hover:underline">
              View my reports
            </Link>
          </p>
        </div>
      </form>
    </Page>
  );
}
