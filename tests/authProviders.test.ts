import { describe, expect, it } from 'vitest';
import { googleSignInMode } from '../src/lib/googleSignInMode.js';

describe('Continue with Google opens Google in the same tab where that is reliable', () => {
  it('uses a same-tab redirect on the deployed site (handler served from the app’s own address)', () => {
    expect(googleSignInMode('chatatlasai.vercel.app', 'chatatlasai.vercel.app', false)).toBe('redirect');
    expect(googleSignInMode('ChatAtlasAI.vercel.app', 'chatatlasai.vercel.app', false)).toBe('redirect');
  });

  it('always uses a redirect in the installed app', () => {
    expect(googleSignInMode('example-project.firebaseapp.com', 'chatatlasai.vercel.app', true)).toBe('redirect');
  });

  it('uses a popup only where the handler is on another domain (local development, preview URLs)', () => {
    expect(googleSignInMode('example-project.firebaseapp.com', 'localhost:5173', false)).toBe('popup');
    expect(googleSignInMode('chatatlasai.vercel.app', 'atlasai-git-branch.vercel.app', false)).toBe('popup');
    expect(googleSignInMode(undefined, 'chatatlasai.vercel.app', false)).toBe('popup');
  });
});
