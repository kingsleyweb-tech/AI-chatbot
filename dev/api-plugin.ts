import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Serves the Vercel-style `api/*.ts` web handlers from the Vite dev server,
 * so `npm run dev` runs the full stack locally without the Vercel CLI.
 */
export function apiDevPlugin(): Plugin {
  let emulatorVerifierSet = false;
  return {
    name: 'tessera-api-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
        try {
          const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as Record<
            string,
            ((r: Request) => Promise<Response>) | undefined
          >;
          // Local end-to-end tests against the Firebase emulators: emulator ID tokens are
          // unsigned, so they are decoded instead of verified (dev server only, never deployed).
          // Scripted AI instead of Gemini/OpenRouter generation (no provider quota is used).
          // Checked on every request (Vite may reload the provider modules after an edit) and
          // installed before the request runs: if the script fails to load, the request fails
          // instead of silently reaching the real providers.
          if (process.env.E2E_FAKE_AI === '1') {
            const registry = (await server.ssrLoadModule('/server/providers/registry.ts')) as typeof import('../server/providers/registry.js');
            const { fakeProvider } = (await server.ssrLoadModule('/dev/fakeAi.ts')) as typeof import('./fakeAi.js');
            const cf = (await server.ssrLoadModule('/server/cloudflare/client.ts')) as typeof import('../server/cloudflare/client.js');
            const { fakeCloudflare } = (await server.ssrLoadModule('/dev/fakeAi.ts')) as typeof import('./fakeAi.js');
            cf.setCloudflareFake(fakeCloudflare);
            for (const model of ['gemini:any', 'openrouter/any', '@cf/any']) {
              const provider = registry.providerFor(model) as ReturnType<typeof registry.providerFor> & { __scripted?: boolean };
              if (provider.__scripted) continue;
              Object.assign(provider, fakeProvider(provider.id), { __scripted: true });
              console.log(`[api-dev] E2E_FAKE_AI: ${provider.id} uses scripted replies, no provider calls`);
            }
          }
          if (process.env.FIREBASE_AUTH_EMULATOR_HOST && !emulatorVerifierSet) {
            const auth = (await server.ssrLoadModule('/server/auth.ts')) as typeof import('../server/auth.js');
            const { decodeJwt } = await import('jose');
            auth.setTokenVerifier(async (token) => decodeJwt(token));
            emulatorVerifierSet = true;
          }
          const handler = mod[req.method ?? 'GET'];
          if (!handler) {
            res.statusCode = 405;
            res.end('Method not allowed');
            return;
          }
          const controller = new AbortController();
          res.on('close', () => {
            if (!res.writableFinished) controller.abort();
          });
          const body =
            req.method === 'GET' || req.method === 'HEAD'
              ? undefined
              : (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>);
          const request = new Request(url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body,
            signal: controller.signal,
            // @ts-expect-error node fetch requires duplex for streamed bodies
            duplex: 'half',
          });
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          if (!response.body) return res.end();
          const reader = response.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (err) {
          if (err instanceof Error && /Failed to load url/.test(err.message)) {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          console.error('[api-dev]', err);
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        }
      });
    },
  };
}
