import { motion } from 'framer-motion';
import { Code2, FileSearch, Lightbulb, PenLine } from 'lucide-react';
import { LogoMark } from '@/components/Logo';
import { useAuth } from '@/state/auth';

const SUGGESTIONS = [
  { icon: Lightbulb, label: 'Think through a decision', prompt: 'Help me think through a decision. Ask me a few questions first, then lay out the trade-offs.' },
  { icon: PenLine, label: 'Draft a message', prompt: 'Draft a clear, concise message for me. Ask what it is about and who it is for.' },
  { icon: Code2, label: 'Review some code', prompt: 'I want you to review some code for bugs, clarity and performance. I will paste it next.' },
  { icon: FileSearch, label: 'Summarize a document', prompt: 'I will attach a document. Summarize its key points and list any action items.' },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Welcome({ projectName, onPrompt }: { projectName?: string; onPrompt: (text: string) => void }) {
  const { user, profile } = useAuth();
  const name = (profile?.displayName || user?.displayName || '').split(' ')[0];
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-10">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex w-full max-w-2xl flex-col items-center text-center"
      >
        <LogoMark className="mb-5 size-10" />
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">
          {projectName ? projectName : `${greeting()}${name ? `, ${name}` : ''}`}
        </h1>
        <p className="mt-2 text-[15px] text-muted">
          {projectName ? 'Chats here use this project’s instructions.' : 'What can I help you with today?'}
        </p>
        <div className="mt-8 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => onPrompt(s.prompt)}
              className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3 text-left text-sm text-fg transition-colors hover:border-border-strong hover:bg-surface"
            >
              <s.icon className="size-4 shrink-0 text-accent" />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
