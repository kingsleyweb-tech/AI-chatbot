/**
 * Branded transactional email templates (HTML + plain text).
 *
 * Layout: white card, Atlas AI logo and name in the header, deep teal text
 * and a cyan accent. Table-based with inline styles so it renders in Gmail,
 * Outlook and Apple Mail, and readable on phones (fluid width, max 560 px).
 * Every dynamic value is HTML-escaped.
 */

export type EmailType =
  | 'welcome'
  | 'verify_email'
  | 'otp'
  | 'password_reset_code'
  | 'password_reset_requested'
  | 'password_changed'
  | 'new_login'
  | 'suspicious_login'
  | 'failed_logins'
  | 'security_change'
  | 'support_update'
  | 'access_approved'
  | 'admin_message'
  | 'account_deletion'
  | 'deletion_reminder'
  | 'restore_confirm'
  | 'restore_result';

export const EMAIL_TYPES: readonly EmailType[] = [
  'welcome',
  'verify_email',
  'otp',
  'password_reset_code',
  'password_reset_requested',
  'password_changed',
  'new_login',
  'suspicious_login',
  'failed_logins',
  'security_change',
  'support_update',
  'access_approved',
  'admin_message',
  'account_deletion',
  'deletion_reminder',
  'restore_confirm',
  'restore_result',
];

/** What signed in, for login and security emails (coarse, never the full user agent). */
export interface DeviceFacts {
  device: string; // "Phone", "Computer", "Tablet"
  os: string;
  browser: string;
  /** partially hidden IP, e.g. 102.176.x.x */
  ip?: string | null;
  /** approximate, from the IP; omitted when unknown */
  location?: string | null;
}

export interface TemplateData {
  name?: string | null;
  /** sign-in alert: the device was seen on this account before */
  knownDevice?: boolean;
  code?: string;
  minutes?: number;
  /** what the code is for (otp) */
  purpose?: string;
  /** when it happened (epoch ms) */
  at?: number;
  /** IANA time zone for dates, e.g. Africa/Accra; UTC otherwise */
  timeZone?: string | null;
  device?: DeviceFacts | null;
  /** short reason for a suspicious-activity email */
  reason?: string;
  /** failed attempts */
  count?: number;
  /** what changed (security_change), e.g. "A phone number was added" */
  change?: string;
  /** support_update: the report and what happened */
  support?: {
    ref: string;
    title: string;
    kind: 'reply' | 'info_request' | 'status' | 'resolved';
    /** status label, e.g. "Under review" */
    status: string;
    /** first part of the team's reply */
    reply?: string | null;
  };
  /** account_deletion: when the account will be permanently deleted (epoch ms) */
  purgeAfter?: number;
  /** account_deletion: where to write to keep the account */
  contact?: string;
  /** signed token for the account-restore page (cancel deletion / confirm a restore request) */
  restoreToken?: string;
  /** restore_result */
  restoreOutcome?: 'restored' | 'declined';
  /** admin_message: written by an administrator (plain text, escaped like everything else) */
  message?: { subject: string; body: string };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const C = {
  ink: '#1f2937',
  muted: '#5b6472',
  teal: '#0b4f5c',
  cyan: '#0e7490',
  cyanSoft: '#ecfeff',
  cyanLine: '#a5f3fc',
  line: '#e5e7eb',
  warnBg: '#fffbeb',
  warnLine: '#fcd34d',
  warnInk: '#92400e',
};
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "9 November 2026, 14:05 GMT" in the person's time zone when known, otherwise UTC. */
export function formatWhen(at: number, timeZone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timeZone || 'UTC' }).format(
      new Date(at),
    );
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(at));
  }
}

const firstName = (name?: string | null) => (name ?? '').trim().split(/\s+/)[0]?.slice(0, 40) || '';
const greeting = (name?: string | null) => (firstName(name) ? `Hi ${firstName(name)},` : 'Hi,');

interface Block {
  html: string;
  text: string;
}
const p = (t: string): Block => ({
  html: `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${C.ink};">${esc(t)}</p>`,
  text: t,
});
const small = (t: string): Block => ({
  html: `<p style="margin:0 0 12px;font-size:13px;line-height:20px;color:${C.muted};">${esc(t)}</p>`,
  text: t,
});

function codeBox(code: string, minutes: number): Block {
  return {
    html:
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;"><tr>` +
      `<td style="background:${C.cyanSoft};border:1px solid ${C.cyanLine};border-radius:12px;padding:14px 22px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;line-height:36px;letter-spacing:8px;font-weight:700;color:${C.teal};">${esc(code)}</td>` +
      `</tr></table>` +
      `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${C.muted};">This code expires in ${esc(minutes)} minutes and can be used once.</p>`,
    text: `Your code: ${code}\n(expires in ${minutes} minutes, single use)`,
  };
}

function button(label: string, href: string): Block {
  return {
    html:
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;"><tr>` +
      `<td align="center" bgcolor="${C.cyan}" style="border-radius:10px;">` +
      `<a href="${esc(href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(label)}</a>` +
      `</td></tr></table>`,
    text: `${label}: ${href}`,
  };
}

function details(rows: [string, string | null | undefined][]): Block {
  const shown = rows.filter((r): r is [string, string] => Boolean(r[1]));
  return {
    html:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;border-top:1px solid ${C.line};">` +
      shown
        .map(
          ([k, v]) =>
            `<tr><td style="padding:13px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.muted};vertical-align:top;">${esc(k)}</td>` +
            `<td align="right" style="padding:13px 0 13px 16px;border-bottom:1px solid ${C.line};font-size:15px;color:${C.ink};font-weight:500;text-align:right;vertical-align:top;">${esc(v)}</td></tr>`,
        )
        .join('') +
      `</table>`,
    text: shown.map(([k, v]) => `${k}: ${v}`).join('\n'),
  };
}

/** a quoted message, e.g. the support team's reply */
function quote(t: string): Block {
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td style="border-left:3px solid ${C.cyan};padding:4px 0 4px 14px;font-size:14px;line-height:21px;color:${C.ink};white-space:pre-line;">${esc(t)}</td></tr></table>`,
    text: t
      .split(String.fromCharCode(10))
      .map((l) => '> ' + l)
      .join(String.fromCharCode(10)),
  };
}

function notice(t: string): Block {
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td style="border-left:3px solid ${C.warnLine};background:${C.warnBg};padding:10px 14px;font-size:14px;line-height:21px;color:${C.warnInk};">${esc(t)}</td></tr></table>`,
    text: `! ${t}`,
  };
}

function deviceRows(d: TemplateData): [string, string | null | undefined][] {
  const dev = d.device;
  return [
    ['Device', dev ? `${dev.device} · ${dev.os}` : null],
    ['Browser', dev?.browser],
    ['Approximate location', dev?.location],
    ['IP address', dev?.ip],
    ['Date and time', d.at ? formatWhen(d.at, d.timeZone) : null],
  ];
}

function layout(o: {
  base: string;
  title: string;
  preheader: string;
  blocks: Block[];
  footer: string;
}): { html: string; text: string } {
  const logo = `${o.base}/pwa-192.png`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;font-family:${FONT};"><tr><td style="padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td style="padding:20px 20px 14px;border-bottom:1px solid ${C.line};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="${esc(logo)}" width="40" height="40" alt="Atlas AI" style="display:block;border:0;border-radius:10px;"></td>
<td style="vertical-align:middle;padding-left:12px;font-size:19px;font-weight:700;letter-spacing:-0.2px;color:${C.teal};">Atlas AI</td>
</tr></table>
</td></tr>
<tr><td style="padding:22px 20px 6px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:${C.teal};">${esc(o.title)}</h1>
${o.blocks.map((b) => b.html).join('\n')}
</td></tr>
<tr><td style="padding:16px 20px 26px;border-top:1px solid ${C.line};">
<p style="margin:0 0 6px;font-size:12px;line-height:18px;color:${C.muted};">${esc(o.footer)}</p>
<p style="margin:0;font-size:12px;line-height:18px;color:${C.muted};">Atlas AI · <a href="${esc(o.base)}" style="color:${C.cyan};text-decoration:none;">${esc(o.base.replace(/^https?:\/\//, ''))}</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  const text = [
    `Atlas AI`,
    '',
    o.title,
    '',
    ...o.blocks.map((b) => b.text).flatMap((t) => [t, '']),
    '--',
    o.footer,
    o.base,
  ].join('\n');
  return { html, text };
}

const FOOT_ACCOUNT = 'You are receiving this email because it is about your Atlas AI account.';
const FOOT_OPTIONAL =
  'You can turn these alerts off in Settings › Security and activity › Notifications.';
const NOT_YOU =
  'If this was not you, change your password now and sign out of every device from Settings › Security and activity.';

/** "13 December 2026" in the person's time zone (UTC when unknown). */
function dateOnly(at: number, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: timeZone || 'UTC' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at);
  }
}

export function render(type: EmailType, d: TemplateData, base: string): RenderedEmail {
  const security = `${base}/settings/security`;
  const minutes = d.minutes ?? 10;
  let subject: string;
  let title: string;
  let preheader: string;
  let blocks: Block[];
  let footer = FOOT_ACCOUNT;

  switch (type) {
    case 'welcome':
      subject = 'Welcome to Atlas AI';
      title = 'Welcome to Atlas AI';
      preheader = 'Your account is ready.';
      blocks = [
        p(greeting(d.name)),
        p(
          'Your Atlas AI account is ready. Ask questions, search the web, work with your documents and talk with Atlas by voice.',
        ),
        button('Open Atlas AI', base),
        small(
          'Keep your account safe: use a strong password and never share verification codes with anyone. Atlas AI will never ask you for them.',
        ),
      ];
      break;
    case 'verify_email':
      subject = `${d.code} is your Atlas AI verification code`;
      title = 'Verify your email address';
      preheader = 'Enter this code to finish setting up your account.';
      blocks = [
        p(greeting(d.name)),
        p('Enter this code in Atlas AI to verify your email address:'),
        codeBox(d.code ?? '', minutes),
        small('If you did not create an Atlas AI account, you can ignore this email.'),
      ];
      break;
    case 'otp':
      subject = `${d.code} is your Atlas AI security code`;
      title = 'Your security code';
      preheader = `Use this code to ${d.purpose ?? 'confirm the action'}.`;
      blocks = [
        p(greeting(d.name)),
        p(`Use this code to ${d.purpose ?? 'confirm the action'}:`),
        codeBox(d.code ?? '', minutes),
        small('Never share this code. Atlas AI will never ask you for it by phone, chat or email.'),
        small(
          `If you did not ask for this code, ${NOT_YOU.charAt(0).toLowerCase()}${NOT_YOU.slice(1)}`,
        ),
      ];
      break;
    case 'password_reset_code':
      subject = `${d.code} is your Atlas AI password reset code`;
      title = 'Reset your password';
      preheader = 'Enter this code to choose a new password.';
      blocks = [
        p(greeting(d.name)),
        p(
          'We received a request to reset the password for your Atlas AI account. Enter this code to choose a new password:',
        ),
        codeBox(d.code ?? '', minutes),
        small(
          'If you did not ask to reset your password, ignore this email: your password stays the same. Never share this code with anyone.',
        ),
      ];
      break;
    case 'password_reset_requested':
      subject = 'Password reset requested for your Atlas AI account';
      title = 'Password reset requested';
      preheader = 'Someone asked to reset your password.';
      blocks = [
        p(greeting(d.name)),
        p(
          'Someone asked to reset the password of your Atlas AI account and a code was sent to your verified phone number.',
        ),
        details([
          ['Date and time', d.at ? formatWhen(d.at, d.timeZone) : null],
          ['Approximate location', d.device?.location],
          ['IP address', d.device?.ip],
        ]),
        small(
          'If this was you, there is nothing else to do. If it was not, ignore the code and do not share it: your password only changes when the code is entered.',
        ),
        button('Review account security', security),
      ];
      break;
    case 'password_changed':
      subject = 'Your Atlas AI password was changed';
      title = 'Your password was changed';
      preheader = 'The password of your account was just changed.';
      blocks = [
        p(greeting(d.name)),
        p(`The password of your Atlas AI account was changed${d.reason ? ` (${d.reason})` : ''}.`),
        details(deviceRows(d)),
        notice(
          'If you did not change your password, reset it right away from the sign-in page and contact the administrator.',
        ),
        button('Review account security', security),
      ];
      break;
    case 'new_login':
      subject = 'New sign-in to your Atlas AI account';
      title = d.knownDevice ? 'New sign-in to your account' : 'New sign-in on a new device';
      preheader = `Your account was signed in to from ${d.device ? `${d.device.browser} on ${d.device.os}` : 'a device'}.`;
      blocks = [
        p(greeting(d.name)),
        p(
          d.knownDevice
            ? 'Your Atlas AI account was just signed in to from a device you have used before.'
            : 'Your Atlas AI account was just signed in to from a device we have not seen before.',
        ),
        details(deviceRows(d)),
        small(`If this was you, you can ignore this email. ${NOT_YOU}`),
        button('Review account security', security),
      ];
      footer = `${FOOT_ACCOUNT} ${FOOT_OPTIONAL}`;
      break;
    case 'suspicious_login':
      subject = 'Unusual sign-in to your Atlas AI account';
      title = 'Unusual sign-in detected';
      preheader = 'Please check this sign-in.';
      blocks = [
        p(greeting(d.name)),
        notice(d.reason ?? 'This sign-in looks different from how you usually sign in.'),
        details(deviceRows(d)),
        small(`If this was you, you can ignore this email. ${NOT_YOU}`),
        button('Review account security', security),
      ];
      footer = `${FOOT_ACCOUNT} ${FOOT_OPTIONAL}`;
      break;
    case 'failed_logins':
      subject = 'Failed sign-in attempts on your Atlas AI account';
      title = 'Several failed sign-in attempts';
      preheader = 'Someone entered a wrong password for your account.';
      blocks = [
        p(greeting(d.name)),
        p(
          `There were ${d.count ?? 'several'} failed attempts to sign in to your Atlas AI account with a wrong password in the last hour.`,
        ),
        details(deviceRows(d)),
        small(
          'Your account is safe as long as nobody knows your password. If these attempts were not you, consider changing your password to a stronger one.',
        ),
        button('Review account security', security),
      ];
      footer = `${FOOT_ACCOUNT} ${FOOT_OPTIONAL}`;
      break;
    case 'security_change':
      subject = 'Security settings changed on your Atlas AI account';
      title = 'Your security settings changed';
      preheader = d.change ?? 'A security setting of your account changed.';
      blocks = [
        p(greeting(d.name)),
        p(`${d.change ?? 'A security setting of your account changed'}.`),
        details(deviceRows(d)),
        small(`If this was you, there is nothing else to do. ${NOT_YOU}`),
        button('Review account security', security),
      ];
      footer = `${FOOT_ACCOUNT} ${FOOT_OPTIONAL}`;
      break;
    case 'account_deletion':
    case 'deletion_reminder': {
      const until = dateOnly(d.purgeAfter ?? (d.at ?? Date.now()) + 30 * 86_400_000, d.timeZone);
      const cancel = d.restoreToken ? `${base}/account-restore?k=cancel&t=${encodeURIComponent(d.restoreToken)}` : null;
      const keep = cancel
        ? `To keep it, press the button below before ${until}.`
        : `To keep it, write to ${d.contact ?? 'Atlas AI support'} before ${until}.`;
      if (type === 'account_deletion') {
        subject = 'Your Atlas AI account will be deleted';
        title = 'Your account is scheduled for deletion';
        preheader = `It will be permanently deleted on ${until}.`;
        blocks = [
          p(greeting(d.name)),
          p('You asked to delete your Atlas AI account. It has been switched off and every device has been signed out.'),
          details([
            ['Requested', d.at ? formatWhen(d.at, d.timeZone) : null],
            ['Permanent deletion', until],
          ]),
          p(`Until then your conversations, memories, documents and settings are kept, and the account can be restored. ${keep} After that date everything is deleted for good and cannot be recovered.`),
          ...(cancel ? [button('Cancel deletion', cancel)] : []),
          notice(`If you did not ask for this, ${cancel ? 'cancel the deletion with the button above and then change your password' : `write to ${d.contact ?? 'Atlas AI support'} right away so we can restore your account and secure it`}.`),
        ];
      } else {
        subject = 'Your Atlas AI account will be deleted in 7 days';
        title = 'Last reminder: your account will be deleted';
        preheader = `On ${until} your account and everything in it will be deleted for good.`;
        blocks = [
          p(greeting(d.name)),
          p(`Your Atlas AI account is scheduled for permanent deletion on ${until}. Your conversations, memories, documents and settings are still kept until then.`),
          p(`If you want to keep your account, ${cancel ? 'press the button below' : `write to ${d.contact ?? 'Atlas AI support'}`}. If you are happy for it to go, there is nothing to do.`),
          ...(cancel ? [button('Keep my account', cancel)] : []),
        ];
      }
      break;
    }
    case 'restore_confirm': {
      const link = `${base}/account-restore?k=confirm&t=${encodeURIComponent(d.restoreToken ?? '')}`;
      subject = 'Confirm your Atlas AI restore request';
      title = 'Confirm your restore request';
      preheader = 'Confirm that you asked to get your Atlas AI account back.';
      blocks = [
        p(greeting(d.name)),
        p('Someone asked to restore the Atlas AI account that uses this email address. If it was you, confirm the request and an administrator will review it.'),
        button('Confirm my request', link),
        small(`The link works for 24 hours.${d.purgeAfter ? ` Your account can be restored until ${dateOnly(d.purgeAfter, d.timeZone)}.` : ''} If you did not ask for this, ignore this email: nothing will change.`),
      ];
      break;
    }
    case 'restore_result':
      if (d.restoreOutcome === 'restored') {
        subject = 'Your Atlas AI account is back';
        title = 'Your account has been restored';
        preheader = 'You can sign in again.';
        blocks = [
          p(greeting(d.name)),
          p('Your restore request was approved. Your account, conversations and data are back, and you can sign in again.'),
          button('Sign in', `${base}/login`),
        ];
      } else {
        subject = 'Your Atlas AI restore request';
        title = 'Your restore request was declined';
        preheader = 'An administrator reviewed your request.';
        blocks = [
          p(greeting(d.name)),
          p(`An administrator reviewed your request and could not restore the account.${d.purgeAfter ? ` It will be permanently deleted on ${dateOnly(d.purgeAfter, d.timeZone)}.` : ''}`),
          small(`Questions? Write to ${d.contact ?? 'Atlas AI support'}.`),
        ];
      }
      break;
    case 'support_update': {
      const s = d.support ?? {
        ref: '',
        title: 'Your report',
        kind: 'status' as const,
        status: 'Updated',
      };
      const link = `${base}/support/${encodeURIComponent(s.ref)}`;
      const reply = s.reply
        ? s.reply.length > 300
          ? `${s.reply.slice(0, 297).trimEnd()}…`
          : s.reply
        : null;
      const rows = details([
        ['Report', `${s.title} (${s.ref})`],
        ['Status', s.status],
      ]);
      if (s.kind === 'resolved') {
        subject = `Your report ${s.ref} was resolved`;
        title = 'Your report was resolved';
        preheader = `${s.title} has been marked as resolved.`;
        blocks = [
          p(greeting(d.name)),
          p('Our team has marked your report as resolved.'),
          rows,
          ...(reply ? [quote(reply)] : []),
          p('Please confirm that the problem is fixed, or reopen the report if it continues.'),
          button('View report', link),
        ];
      } else if (s.kind === 'info_request') {
        subject = `We need more information about report ${s.ref}`;
        title = 'We need a little more information';
        preheader = 'Atlas Support asked a question about your report.';
        blocks = [
          p(greeting(d.name)),
          p('To keep working on your report, our team needs a reply from you.'),
          rows,
          ...(reply ? [quote(reply)] : []),
          button('Reply to the team', link),
        ];
      } else if (s.kind === 'reply') {
        subject = `New reply to your report ${s.ref}`;
        title = 'Atlas Support replied';
        preheader = reply ?? 'There is a new reply to your report.';
        blocks = [
          p(greeting(d.name)),
          p('There is a new reply to your report.'),
          rows,
          ...(reply ? [quote(reply)] : []),
          button('View report', link),
        ];
      } else {
        subject = `Your report ${s.ref} is now ${s.status.toLowerCase()}`;
        title = 'Your report was updated';
        preheader = `Status: ${s.status}.`;
        blocks = [
          p(greeting(d.name)),
          p(`The status of your report changed to ${s.status}.`),
          rows,
          button('View report', link),
        ];
      }
      footer =
        'You are receiving this email because you sent a report to Atlas Support. You can turn these emails off in Settings › Security and activity › Notifications.';
      break;
    }
    case 'access_approved':
      subject = 'Your Atlas AI account has been approved';
      title = 'Your account is approved';
      preheader = 'You can now sign in and start using Atlas AI.';
      blocks = [
        p(greeting(d.name)),
        p('Good news: an administrator has approved your Atlas AI account. You can now sign in and start using it.'),
        button('Open Atlas AI', base),
        small('Sign in with the email address or phone number and password you used to create your account.'),
      ];
      break;
    case 'admin_message': {
      const m = d.message ?? { subject: 'A message from Atlas AI', body: '' };
      subject = m.subject;
      title = m.subject;
      preheader = m.body.replace(/\s+/g, ' ').slice(0, 120);
      blocks = [
        p(greeting(d.name)),
        ...m.body
          .split(/\n\s*\n/)
          .map((para) => para.trim())
          .filter(Boolean)
          .map((para) => p(para)),
        button('Open Atlas AI', base),
      ];
      footer =
        'You are receiving this message from the Atlas AI team. You can turn announcements off in Settings › Security and activity › Notifications.';
      break;
    }
  }
  return { subject, ...layout({ base, title, preheader, blocks, footer }) };
}
