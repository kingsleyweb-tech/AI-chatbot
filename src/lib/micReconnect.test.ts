import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceEngine } from './voiceEngine';

/*
 * iPhones report a "device change" whenever the audio route changes (the reply starting or stopping
 * through the speaker). The microphone must only be reopened when it really stopped or was swapped,
 * or Voice Mode keeps showing "Microphone disconnected — reconnecting…".
 */

type Internals = {
  stream: unknown;
  openedAt: number;
  reopen: () => Promise<void>;
  checkDevice: () => Promise<void>;
};

function engineWith(track: { readyState: string; deviceId: string; groupId: string }, inputs: Partial<MediaDeviceInfo>[]) {
  vi.stubGlobal('navigator', {
    mediaDevices: { enumerateDevices: async () => inputs.map((d) => ({ kind: 'audioinput', ...d })) },
  });
  const engine = new VoiceEngine({} as never) as unknown as Internals;
  engine.stream = { getAudioTracks: () => [{ readyState: track.readyState, getSettings: () => ({ deviceId: track.deviceId, groupId: track.groupId }) }] };
  engine.openedAt = Date.now() - 60_000;
  const reopen = vi.fn(async () => undefined);
  engine.reopen = reopen;
  return { engine, reopen };
}

afterEach(() => vi.unstubAllGlobals());

describe('microphone reconnects', () => {
  it('keeps the microphone when only the audio route changed', async () => {
    const { engine, reopen } = engineWith({ readyState: 'live', deviceId: 'mic1', groupId: 'g1' }, [{ deviceId: 'mic1', groupId: 'g1' }]);
    await engine.checkDevice();
    expect(reopen).not.toHaveBeenCalled();
  });

  it('ignores the change caused by opening the microphone itself', async () => {
    const { engine, reopen } = engineWith({ readyState: 'live', deviceId: 'mic1', groupId: 'g1' }, [{ deviceId: 'other', groupId: 'g2' }]);
    engine.openedAt = Date.now();
    await engine.checkDevice();
    expect(reopen).not.toHaveBeenCalled();
  });

  it('reopens when the microphone stopped', async () => {
    const { engine, reopen } = engineWith({ readyState: 'ended', deviceId: 'mic1', groupId: 'g1' }, [{ deviceId: 'mic1', groupId: 'g1' }]);
    await engine.checkDevice();
    expect(reopen).toHaveBeenCalledOnce();
  });

  it('reopens when the microphone in use was removed', async () => {
    const { engine, reopen } = engineWith({ readyState: 'live', deviceId: 'headset', groupId: 'g2' }, [{ deviceId: 'mic1', groupId: 'g1' }]);
    await engine.checkDevice();
    expect(reopen).toHaveBeenCalledOnce();
  });

  it('follows the system default when a headset is plugged in', async () => {
    const { engine, reopen } = engineWith({ readyState: 'live', deviceId: 'default', groupId: 'g1' }, [
      { deviceId: 'default', groupId: 'g2' },
      { deviceId: 'mic1', groupId: 'g1' },
      { deviceId: 'headset', groupId: 'g2' },
    ]);
    await engine.checkDevice();
    expect(reopen).toHaveBeenCalledOnce();
  });
});
