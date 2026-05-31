const http = require('http');

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function startHealthServer({ port }) {
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'kra-race-ticket-bot',
        uptime: Math.round(process.uptime()),
      });
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: 'not found',
    });
  });

  server.listen(port, () => {
    console.log(`[health] listening on port ${port}`);
  });

  server.on('error', (error) => {
    console.error('[health]', error);
  });

  return server;
}

function startKeepAlivePing({ url, intervalMs }) {
  if (!url) return null;

  const ping = async () => {
    try {
      const response = await fetch(url);
      console.log(`[keep-alive] ${url} -> ${response.status}`);
    } catch (error) {
      console.error(`[keep-alive] ${error.message}`);
    }
  };

  const timer = setInterval(ping, intervalMs);
  timer.unref();
  ping();
  return timer;
}

function startKeepAlive({ port, url, intervalMs }) {
  const server = startHealthServer({ port });
  const timer = startKeepAlivePing({ url, intervalMs });
  return { server, timer };
}

module.exports = {
  startKeepAlive,
  startHealthServer,
  startKeepAlivePing,
};
