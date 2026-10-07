// The scripts' own Vite server. Vite turns `port: 0` into its default 5173 and binds `localhost`, which is
// [::1] where IPv6 comes first: a script run then sits on [::1]:5173 beside a dev server on 127.0.0.1:5173,
// and a browser that opens http://localhost:5173 is served the script's tree instead of the live app. So the
// OS assigns a free port on 127.0.0.1 and Vite must take exactly that one.
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'vite';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Starts a Vite server for `root` on 127.0.0.1 at an OS-assigned port; returns { server, base }. */
export async function startLocalServer(root, serverOptions = {}) {
  const port = await freePort();
  const server = await createServer({ root, server: { ...serverOptions, host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' });
  await server.listen();
  return { server, base: `http://127.0.0.1:${port}` };
}
