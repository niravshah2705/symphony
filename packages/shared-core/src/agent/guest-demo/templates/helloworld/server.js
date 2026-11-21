'use strict';

/**
 * The Node.js variant of the hello-world starter: the same static page, served
 * by a dependency-free server so it also runs with `node server.js` anywhere.
 * Firebase Hosting serves the files directly, so the preview release never
 * executes this — it ships so the visitor can download and run the site.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const port = Number(process.env.PORT) || 8080;

http.createServer((req, res) => {
  const requested = req.url === '/' ? 'index.html' : req.url.slice(1);
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`hello-world starter on http://127.0.0.1:${port}/`));
