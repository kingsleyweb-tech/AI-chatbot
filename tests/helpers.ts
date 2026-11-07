import type { ModelInfo } from '../server/shared/types.js';

type Caps = Partial<ModelInfo['capabilities']>;

/** Build a catalog entry for tests. `vision`/`code` shortcuts set capabilities. */
export function fakeModel(id: string, opts: Partial<Omit<ModelInfo, 'capabilities'>> & Caps = {}): ModelInfo {
  const { vision, audioInput, fileInput, imageOutput, audioOutput, tools, reasoning, structuredOutput, streaming, code, ...rest } = opts;
  return {
    id,
    name: id,
    provider: 'openrouter',
    vendor: id.split('/')[0],
    description: '',
    contextLength: 100_000,
    inputModalities: vision ? ['text', 'image'] : ['text'],
    outputModalities: imageOutput ? ['text', 'image'] : ['text'],
    free: id.endsWith(':free'),
    capabilities: {
      vision: Boolean(vision),
      audioInput: Boolean(audioInput),
      fileInput: Boolean(fileInput),
      imageOutput: Boolean(imageOutput),
      audioOutput: Boolean(audioOutput),
      tools: Boolean(tools),
      reasoning: Boolean(reasoning),
      structuredOutput: Boolean(structuredOutput),
      streaming: streaming ?? true,
      code: Boolean(code),
    },
    available: true,
    featured: false,
    ...rest,
  };
}
