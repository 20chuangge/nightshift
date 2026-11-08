/**
 * A minimal WebSocket client (RFC 6455) - just enough for Chrome DevTools
 * Protocol on ws://127.0.0.1.
 *
 * Why it exists: Node only ships a global `WebSocket` from 22. The desktop
 * shell runs its server on Electron's bundled Node (20.x here), so relying on
 * the global would silently disable every browser tool in the packaged app.
 * This module keeps the CDP path working on Node 18+ with no dependencies.
 *
 * Scope, deliberately: text frames in both directions, fragmentation,
 * ping/pong, close. No TLS (CDP is loopback), no compression, no subprotocol
 * negotiation, no client-side masking negotiation.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class MiniWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, { timeoutMs = 10000 } = {}) {
    this.url = url;
    this.readyState = MiniWebSocket.CONNECTING;
    this._listeners = new Map();
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;
    this._closed = false;

    const u = new URL(url);
    // wss:// too (Feishu long connection); still no compression or subprotocols.
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      throw new Error(`MiniWebSocket only speaks ws:// and wss:// (got ${u.protocol})`);
    }
    const secure = u.protocol === 'wss:';
    const host = u.hostname;
    const port = Number(u.port || (secure ? 443 : 80));
    const key = crypto.randomBytes(16).toString('base64');
    const pathWithQuery = `${u.pathname}${u.search || ''}`;
    const hostHeader = u.port ? `${host}:${port}` : host;

    const onConnect = () => {
      this._socket.write(
        `GET ${pathWithQuery} HTTP/1.1\r\n` +
          `Host: ${hostHeader}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    };
    this._socket = secure
      ? tls.connect({ host, port, servername: host }, onConnect)
      : net.connect({ host, port }, onConnect);
    this._socket.setNoDelay(true);
    this._socket.setTimeout(timeoutMs, () => {
      this._fail(new Error(`websocket handshake timed out after ${timeoutMs}ms`));
    });

    let handshakeDone = false;
    this._socket.on('data', (chunk) => {
      if (!handshakeDone) {
        const text = chunk.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end === -1) {
          this._buffer = Buffer.concat([this._buffer, chunk]);
          return;
        }
        const head = text.slice(0, end);
        const rest = chunk.subarray(Buffer.byteLength(text.slice(0, end + 4), 'latin1'));
        this._buffer = Buffer.alloc(0);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          this._fail(new Error(`websocket handshake failed: ${head.split('\r\n')[0]}`));
          return;
        }
        const accept = crypto
          .createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        if (!head.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) {
          this._fail(new Error('websocket handshake failed: bad accept key'));
          return;
        }
        handshakeDone = true;
        this.readyState = MiniWebSocket.OPEN;
        this._socket.setTimeout(0);
        this._emit('open', {});
        if (rest.length) this._onBytes(rest);
        return;
      }
      this._onBytes(chunk);
    });

    this._socket.on('close', () => this._finish());
    this._socket.on('error', (err) => this._fail(err));
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  _emit(type, event) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* a broken listener must not kill the socket */
      }
    }
  }

  _fail(err) {
    if (this._closed) return;
    this._emit('error', { error: err, message: err.message });
    this._finish();
  }

  _finish() {
    if (this._closed) return;
    this._closed = true;
    this.readyState = MiniWebSocket.CLOSED;
    try {
      this._socket.destroy();
    } catch {
      /* already gone */
    }
    this._emit('close', { code: 1006, reason: '' });
  }

  _onBytes(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this._buffer.length < 4) return;
        len = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buffer.length < 10) return;
        const big = this._buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          this._fail(new Error('websocket frame too large'));
          return;
        }
        len = Number(big);
        offset = 10;
      }

      let mask = null;
      if (masked) {
        if (this._buffer.length < offset + 4) return;
        mask = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this._buffer.length < offset + len) return;

      let payload = this._buffer.subarray(offset, offset + len);
      this._buffer = this._buffer.subarray(offset + len);
      if (mask) {
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }

      if (opcode === OP_PING) {
        this._sendFrame(OP_PONG, payload);
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_CLOSE) {
        this._sendFrame(OP_CLOSE, payload.subarray(0, 2));
        this._finish();
        return;
      }
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (fin) {
          this._deliver(opcode, payload);
        } else {
          this._fragments = [payload];
          this._fragmentOp = opcode;
        }
        continue;
      }
      if (opcode === OP_CONT && this._fragmentOp !== null) {
        this._fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this._fragments);
          const op = this._fragmentOp;
          this._fragments = [];
          this._fragmentOp = null;
          this._deliver(op, whole);
        }
      }
    }
  }

  _deliver(opcode, buf) {
    // CDP is always text; binary frames are passed through as a Buffer.
    this._emit('message', { data: opcode === OP_TEXT ? buf.toString('utf8') : buf });
  }

  _sendFrame(opcode, payload) {
    if (this.readyState !== MiniWebSocket.OPEN) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    try {
      this._socket.write(Buffer.concat([header, mask, masked]));
    } catch (err) {
      this._fail(err);
    }
  }

  send(data) {
    if (this.readyState !== MiniWebSocket.OPEN) {
      throw new Error('websocket is not open');
    }
    // A Buffer / Uint8Array goes out as a binary frame (protobuf), the rest as text.
    if (data instanceof Uint8Array) this._sendFrame(OP_BINARY, Buffer.from(data));
    else this._sendFrame(OP_TEXT, Buffer.from(String(data), 'utf8'));
  }

  close(code = 1000) {
    if (this.readyState === MiniWebSocket.CLOSED) return;
    this.readyState = MiniWebSocket.CLOSING;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this._sendFrame(OP_CLOSE, payload);
    setTimeout(() => this._finish(), 50).unref?.();
  }
}

/** True when the runtime already provides a spec-compliant global WebSocket. */
export function hasNativeWebSocket() {
  return typeof globalThis.WebSocket === 'function';
}
