/**
 * Minimal wire-protocol stand-ins, so the real `pg`, `redis` and `ioredis`
 * drivers run end to end without a database:
 *
 *  - PostgreSQL frontend/backend protocol 3.0: startup with no authentication,
 *    the simple query flow and the extended (parse / bind / execute) flow, one
 *    text column per result, and an error response for a statement containing
 *    the word `fail`.
 *  - RESP2: `PING`, `GET`, `SET`, `DEL`, `HELLO` (refused, so clients stay on
 *    RESP2), `CLIENT` and `INFO`, and an error for the command `FAIL`.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface WireServer {
  port: number;
  /** Statements or commands received, in order. */
  received: string[];
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));
}

function closer(server: Server, sockets: Set<Socket>): () => Promise<void> {
  return () =>
    new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    });
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

function pgMessage(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
const cstring = (text: string): Buffer => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);

function rowDescription(column: string): Buffer {
  const tail = Buffer.alloc(18);
  tail.writeInt32BE(0, 0); // table oid
  tail.writeInt16BE(0, 4); // column number
  tail.writeInt32BE(25, 6); // type oid: text
  tail.writeInt16BE(-1, 10); // type size
  tail.writeInt32BE(-1, 12); // type modifier
  tail.writeInt16BE(0, 16); // text format
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  return pgMessage('T', Buffer.concat([count, cstring(column), tail]));
}

function dataRow(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const head = Buffer.alloc(6);
  head.writeInt16BE(1, 0);
  head.writeInt32BE(bytes.length, 2);
  return pgMessage('D', Buffer.concat([head, bytes]));
}

const READY = pgMessage('Z', Buffer.from('I'));
const errorResponse = (message: string): Buffer =>
  pgMessage('E', Buffer.concat([Buffer.from('S'), cstring('ERROR'), Buffer.from('C'), cstring('42601'), Buffer.from('M'), cstring(message), Buffer.from([0])]));
const rows = (): Buffer => Buffer.concat([dataRow('pong'), pgMessage('C', cstring('SELECT 1'))]);

export async function startPgServer(): Promise<WireServer> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    let started = false;
    let pending = '';
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const code = buffer.readInt32BE(4);
          buffer = buffer.subarray(length);
          if (code === 80877103) {
            socket.write('N'); // SSL refused; the startup message follows.
            continue;
          }
          started = true;
          socket.write(Buffer.concat([pgMessage('R', Buffer.from([0, 0, 0, 0])), READY]));
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0] as number);
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) return;
        const body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);
        switch (type) {
          case 'Q': {
            const sql = body.subarray(0, body.length - 1).toString('utf8');
            received.push(sql);
            socket.write(/fail/i.test(sql) ? Buffer.concat([errorResponse('syntax error at or near "fail"'), READY]) : Buffer.concat([rowDescription('answer'), rows(), READY]));
            break;
          }
          case 'P': {
            // statement name, then the query text
            const nameEnd = body.indexOf(0);
            const queryEnd = body.indexOf(0, nameEnd + 1);
            pending = body.subarray(nameEnd + 1, queryEnd).toString('utf8');
            received.push(pending);
            socket.write(pgMessage('1'));
            break;
          }
          case 'B':
            socket.write(pgMessage('2'));
            break;
          case 'D':
            socket.write(/fail/i.test(pending) ? errorResponse('syntax error at or near "fail"') : rowDescription('answer'));
            break;
          case 'E':
            if (!/fail/i.test(pending)) socket.write(rows());
            break;
          case 'S':
            socket.write(READY);
            break;
          case 'X':
            socket.end();
            return;
          default:
            break;
        }
      }
    });
  });
  const port = await listen(server);
  return { port, received, close: closer(server, sockets) };
}

// ---------------------------------------------------------------------------
// Redis (RESP2)
// ---------------------------------------------------------------------------

/** One command off the front of a buffer, or undefined if it is not all there yet. */
function readCommand(buffer: Buffer): { parts: string[]; rest: Buffer } | undefined {
  if (buffer.length === 0 || buffer[0] !== 0x2a) return undefined; // '*'
  let offset = buffer.indexOf('\r\n');
  if (offset < 0) return undefined;
  const count = Number(buffer.subarray(1, offset).toString());
  offset += 2;
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) return undefined;
    const length = Number(buffer.subarray(offset + 1, lineEnd).toString());
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return undefined;
    parts.push(buffer.subarray(start, start + length).toString('utf8'));
    offset = start + length + 2;
  }
  return { parts, rest: buffer.subarray(offset) };
}

export async function startRedisServer(replies: Record<string, string> = {}): Promise<WireServer> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const store = new Map<string, string>();
  const bulk = (value: string | undefined): string => (value === undefined ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`);
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const command = readCommand(buffer);
        if (!command) return;
        buffer = command.rest;
        const [name = '', ...args] = command.parts;
        const upper = name.toUpperCase();
        received.push([upper, ...args].join(' '));
        if (replies[upper] !== undefined) {
          socket.write(replies[upper]);
          continue;
        }
        switch (upper) {
          case 'PING':
            socket.write('+PONG\r\n');
            break;
          case 'SET':
            store.set(args[0] ?? '', args[1] ?? '');
            socket.write('+OK\r\n');
            break;
          case 'GET':
            socket.write(bulk(store.get(args[0] ?? '')));
            break;
          case 'DEL':
            socket.write(`:${store.delete(args[0] ?? '') ? 1 : 0}\r\n`);
            break;
          case 'HELLO':
            socket.write('-ERR unknown command `HELLO`\r\n');
            break;
          case 'CLIENT':
          case 'SELECT':
          case 'QUIT':
            socket.write('+OK\r\n');
            break;
          case 'INFO':
            socket.write(bulk('redis_version:7.2.0\r\n'));
            break;
          case 'FAIL':
            socket.write('-ERR this command always fails\r\n');
            break;
          default:
            socket.write(`-ERR unknown command \`${name}\`\r\n`);
        }
      }
    });
  });
  const port = await listen(server);
  return { port, received, close: closer(server, sockets) };
}
