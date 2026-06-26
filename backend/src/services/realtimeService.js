const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

const stream = (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write('retry: 10000\n\n');

  const sendEvent = (type, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const updateListener = (payload) => sendEvent(payload.event || 'update', payload);
  emitter.on('update', updateListener);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(':heartbeat\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    emitter.removeListener('update', updateListener);
  });
};

const publish = (eventType, payload) => {
  emitter.emit('update', { event: eventType, ...payload });
};

module.exports = { stream, publish };
