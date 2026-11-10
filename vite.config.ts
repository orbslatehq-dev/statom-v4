import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import https from 'node:https';
import http from 'node:http';

function followRedirects(targetUrl: string, maxHops = 6): Promise<{ finalUrl: string; bodySnippet: string }> {
  return new Promise((resolve, reject) => {
    const visit = (currentUrl: string, hopsLeft: number) => {
      if (hopsLeft <= 0) {
        resolve({ finalUrl: currentUrl, bodySnippet: '' });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch (err) {
        reject(err);
        return;
      }
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request(
        parsed,
        {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          timeout: 7000,
        },
        (res) => {
          const status = res.statusCode || 200;
          const loc = res.headers.location;
          if (status >= 300 && status < 400 && loc) {
            res.resume();
            const nextUrl = new URL(loc, currentUrl).toString();
            visit(nextUrl, hopsLeft - 1);
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            if (bytes < 48000) {
              chunks.push(chunk);
              bytes += chunk.length;
            } else {
              res.destroy();
            }
          });
          res.on('end', () => {
            resolve({
              finalUrl: currentUrl,
              bodySnippet: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('close', () => {
            resolve({
              finalUrl: currentUrl,
              bodySnippet: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ finalUrl: currentUrl, bodySnippet: '' });
      });
      req.on('error', (err) => reject(err));
      req.end();
    };
    visit(targetUrl, maxHops);
  });
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'RoofMassLK/1.0 (Sri Lanka 3D House Prototype Studio)',
          Accept: 'application/json',
        },
        timeout: 7000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function sriLankaGeoApiPlugin(): Plugin {
  const attachMiddleware = (middlewares: {
    use: (fn: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) => void;
  }) => {
    middlewares.use(async (req, res, next) => {
      if (!req.url) return next();
      const parsed = new URL(req.url, 'http://localhost');

      if (parsed.pathname === '/api/resolve-map-link') {
        const rawUrl = parsed.searchParams.get('url') || '';
        res.setHeader('Content-Type', 'application/json');
        if (!/^https?:\/\//i.test(rawUrl)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid URL' }));
          return;
        }
        try {
          const { finalUrl, bodySnippet } = await followRedirects(rawUrl);
          res.statusCode = 200;
          res.end(JSON.stringify({ finalUrl, bodySnippet: bodySnippet.slice(0, 16000) }));
        } catch {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: 'Failed to resolve short link' }));
        }
        return;
      }

      if (parsed.pathname === '/api/search-lk') {
        const q = (parsed.searchParams.get('q') || '').trim();
        res.setHeader('Content-Type', 'application/json');
        if (!q) {
          res.end(JSON.stringify([]));
          return;
        }
        try {
          const nomUrl = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
            q,
            countrycodes: 'lk',
            format: 'jsonv2',
            addressdetails: '1',
            limit: '6',
          }).toString()}`;
          const data = await fetchJson(nomUrl);
          res.statusCode = 200;
          res.end(JSON.stringify(data));
        } catch {
          res.statusCode = 200;
          res.end(JSON.stringify([]));
        }
        return;
      }

      next();
    });
  };

  return {
    name: 'sri-lanka-geo-api',
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sriLankaGeoApiPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
});
