import crypto from 'node:crypto';
import EventEmitter from 'node:events';

export const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * WebSocketGateway
 * Zero-dependency RFC 6455 compliant WebSocket gateway for real-time
 * multi-agent telemetry streaming, DAG execution broadcasts, and A2A dialogues.
 */
export class WebSocketGateway extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {Function} [options.tokenVerifier] Function(token) => userProfile
   */
  constructor(options = {}) {
    super();
    this.tokenVerifier = options.tokenVerifier || null;
    this.clients = new Map(); // socket -> ClientSession
    this.channels = new Map(); // channelName -> Set<socket>
  }

  /**
   * Attaches to an existing Node.js HTTP server instance
   * @param {import('node:http').Server} server
   * @param {string} [pathPrefix='/api/v2/ws']
   */
  attach(server, pathPrefix = '/api/v2/ws') {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (!url.pathname.startsWith(pathPrefix)) {
        return; // Pass through to other handlers if any
      }

      const secKey = req.headers['sec-websocket-key'];
      if (!secKey) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // Verify Auth Token from query param or header
      const token = url.searchParams.get('token') || req.headers['sec-websocket-protocol'];
      let user = null;
      if (this.tokenVerifier && typeof this.tokenVerifier === 'function') {
        try {
          user = this.tokenVerifier(token);
        } catch (err) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // Complete RFC 6455 Handshake
      const acceptHash = crypto
        .createHash('sha1')
        .update(secKey + WS_MAGIC_STRING)
        .digest('base64');

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptHash}`
      ];

      if (token && req.headers['sec-websocket-protocol']) {
        headers.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol'].split(',')[0].trim()}`);
      }

      socket.write(headers.join('\r\n') + '\r\n\r\n');

      const clientId = `client_${crypto.randomUUID().slice(0, 8)}`;
      const session = {
        id: clientId,
        socket,
        user,
        tenantId: user?.tenantId || 'tenant-default',
        channels: new Set(),
        connectedAt: new Date().toISOString()
      };

      this.clients.set(socket, session);
      this.emit('connection', session);

      // Handle raw socket data frames
      socket.on('data', (buffer) => {
        this._handleSocketData(socket, session, buffer);
      });

      socket.on('close', () => {
        this._removeClient(socket);
      });

      socket.on('error', () => {
        this._removeClient(socket);
      });
    });
  }

  /**
   * Internal frame decoder for incoming client messages
   */
  _handleSocketData(socket, session, buffer) {
    if (buffer.length < 2) return;

    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) === 0x80;

    // Opcode 8: Connection Close
    if (opcode === 0x08) {
      socket.end();
      this._removeClient(socket);
      return;
    }

    // Opcode 9: Ping -> Respond with Pong (Opcode 10)
    if (opcode === 0x09) {
      this._sendFrame(socket, 0x0a, Buffer.alloc(0));
      return;
    }

    // Opcode 1: Text Frame
    if (opcode === 0x01) {
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let payload = buffer.subarray(offset + (isMasked ? 4 : 0), offset + (isMasked ? 4 : 0) + payloadLength);

      if (isMasked) {
        const maskKey = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLength);
        for (let i = 0; i < payloadLength; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }

      try {
        const text = payload.toString('utf8');
        const json = JSON.parse(text);
        this._processClientMessage(session, json);
      } catch (_) {
        // Non-JSON or fragmented frame ignored in minimal gateway
      }
    }
  }

  /**
   * Processes client action commands (SUBSCRIBE, UNSUBSCRIBE, PING)
   */
  _processClientMessage(session, message) {
    if (!message || typeof message !== 'object') return;

    if (message.action === 'SUBSCRIBE' && message.channel) {
      const channel = String(message.channel);
      session.channels.add(channel);
      if (!this.channels.has(channel)) {
        this.channels.set(channel, new Set());
      }
      this.channels.get(channel).add(session.socket);
      this.sendToClient(session.socket, { type: 'SUBSCRIBED', channel });
    } else if (message.action === 'UNSUBSCRIBE' && message.channel) {
      const channel = String(message.channel);
      session.channels.delete(channel);
      if (this.channels.has(channel)) {
        this.channels.get(channel).delete(session.socket);
      }
      this.sendToClient(session.socket, { type: 'UNSUBSCRIBED', channel });
    } else if (message.action === 'PING') {
      this.sendToClient(session.socket, { type: 'PONG', timestamp: Date.now() });
    }
  }

  /**
   * Encodes and sends a WebSocket frame (Server-to-Client frames are unmasked per RFC 6455)
   */
  _sendFrame(socket, opcode, payloadBuffer) {
    if (!socket || socket.destroyed || !socket.writable) return;

    const length = payloadBuffer.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f); // FIN + Opcode
      header[1] = length;                 // Unmasked, length
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      socket.write(Buffer.concat([header, payloadBuffer]));
    } catch (_) {}
  }

  /**
   * Sends a JSON message to a specific client socket
   */
  sendToClient(socket, payload) {
    const jsonStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const buf = Buffer.from(jsonStr, 'utf8');
    this._sendFrame(socket, 0x01, buf);
  }

  /**
   * Broadcasts message to all clients subscribed to a given channel
   */
  broadcastToChannel(channel, event, payload) {
    const sockets = this.channels.get(channel);
    if (!sockets || sockets.size === 0) return;

    const message = {
      channel,
      event,
      payload,
      timestamp: new Date().toISOString()
    };
    const jsonStr = JSON.stringify(message);
    const buf = Buffer.from(jsonStr, 'utf8');

    for (const socket of sockets) {
      this._sendFrame(socket, 0x01, buf);
    }
  }

  /**
   * Broadcasts to project channel: "project:<projectId>"
   */
  broadcastToProject(projectId, event, payload) {
    this.broadcastToChannel(`project:${projectId}`, event, payload);
  }

  /**
   * Cleans up disconnected client
   */
  _removeClient(socket) {
    const session = this.clients.get(socket);
    if (!session) return;

    for (const ch of session.channels) {
      if (this.channels.has(ch)) {
        this.channels.get(ch).delete(socket);
      }
    }
    this.clients.delete(socket);
    this.emit('disconnect', session);
  }

  /**
   * Returns active connection count
   */
  getActiveConnectionsCount() {
    return this.clients.size;
  }
}

