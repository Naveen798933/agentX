export class EventStreamManager {
  constructor() {
    this.clients = new Set();
    this.eventBuffer = []; // ring buffer of recent events for replay
    this.maxBufferSize = 50;
    this.eventId = 0;

    // Periodic heartbeat to prevent socket timeouts
    this.heartbeatTimer = setInterval(() => {
      this._sendHeartbeat();
    }, 15000);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  addClient(req, res, lastEventId = null) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`: connected at ${new Date().toISOString()}\n\n`);

    // Replay missed events if client supplied Last-Event-ID
    if (lastEventId !== null && !isNaN(Number(lastEventId))) {
      const fromId = Number(lastEventId);
      const toReplay = this.eventBuffer.filter(e => e.id > fromId);
      for (const e of toReplay) {
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
      }
    }

    this.clients.add(res);

    req.on('close', () => {
      this.clients.delete(res);
    });

    return () => this.clients.delete(res);
  }

  broadcast(type, payload) {
    this.eventId++;
    const event = {
      id: this.eventId,
      type,
      payload,
      timestamp: new Date().toISOString()
    };

    // Store in ring buffer
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.shift();
    }

    const sseMessage = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(sseMessage);
      } catch (_) {
        this.clients.delete(client);
      }
    }

    return event;
  }

  _sendHeartbeat() {
    for (const client of this.clients) {
      try {
        client.write(`: ping ${Date.now()}\n\n`);
      } catch (_) {
        this.clients.delete(client);
      }
    }
  }

  getConnectedCount() {
    return this.clients.size;
  }

  close() {
    clearInterval(this.heartbeatTimer);
    for (const client of this.clients) {
      try { client.end(); } catch (_) {}
    }
    this.clients.clear();
  }
}
