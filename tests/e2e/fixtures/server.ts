import http from 'node:http';

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (reqUrl.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Clean Page</h1></body></html>');
      return;
    }

    if (reqUrl.pathname === '/console-error') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>Console Error Page</h1>
        <script>console.error('Broken widget state', { code: 42 });</script>
      </body></html>`);
      return;
    }

    if (reqUrl.pathname === '/page-error') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>Page Error</h1>
        <script>
          setTimeout(() => { throw new Error('Async uncaught boom'); }, 15);
        </script>
      </body></html>`);
      return;
    }

    if (reqUrl.pathname === '/unhandled-rejection') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>Unhandled Rejection</h1>
        <script>
          Promise.reject(new Error('Unhandled promise boom'));
        </script>
      </body></html>`);
      return;
    }

    if (reqUrl.pathname === '/fetch-500') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>Fetch 500</h1>
        <button id="trigger" onclick="fetch('/api/boom').then(r => window.__status = r.status)">Trigger 500</button>
      </body></html>`);
      return;
    }

    if (reqUrl.pathname === '/fetch-404') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>Fetch 404</h1>
        <button id="trigger" onclick="fetch('/api/missing').then(r => window.__status = r.status)">Trigger 404</button>
      </body></html>`);
      return;
    }

    if (reqUrl.pathname === '/fetch-aborted') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>Fetch Aborted</h1>
        <script>
          fetch('/api/slow').catch(() => {});
          setTimeout(() => { window.location.href = '/'; }, 30);
        </script>
      </body></html>`);
      return;
    }

    if (reqUrl.pathname === '/popup-opener') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <h1>Popup Opener</h1>
        <button id="open" onclick="window.open('/console-error', '_blank')">Open</button>
      </body></html>`);
      return;
    }

    if (reqUrl.pathname === '/api/boom') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream timeout' }));
      return;
    }

    if (reqUrl.pathname === '/api/missing') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    if (reqUrl.pathname === '/api/slow') {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }
      }, 1500);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind local test server');
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
