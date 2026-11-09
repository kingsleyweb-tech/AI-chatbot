import { motion } from 'framer-motion';
import { LogoMark } from '@/components/Logo';
import { useAuth } from '@/state/auth';
import { firstName } from './greetings';
import { WelcomeGreeting } from './WelcomeGreeting';

export function Welcome({ projectName }: { projectName?: string }) {
  const { user, profile } = useAuth();
  const name = firstName(profile?.displayName || user?.displayName, user?.email);
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-10">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex w-full max-w-2xl flex-col items-center text-center"
      >
        <LogoMark className="mb-5 size-10" />
        {projectName ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{projectName}</h1>
            <p className="mt-2 text-[15px] text-muted">Chats here use this project’s instructions.</p>
          </>
        ) : (
          <WelcomeGreeting name={name} ready={!user || !!profile} />
        )}
      </motion.div>
    </div>
  );
}
