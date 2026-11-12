// A stand-in MCP server over stdio for the smoke test (never a real one).
// Tools (listed over two pages): echo, add, peek (read-only), fail (isError),
// slow (answers after 3 s), picture (an image). "env" echoes FAKE_TOKEN's
// length, so the test can see a secret arrived without printing it.
import readline from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'peek', description: 'Look at something.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Answers after 3 seconds.', inputSchema: { type: 'object', properties: {} } },
  { name: 'picture', description: 'Returns a tiny image.', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Says whether FAKE_TOKEN arrived.', inputSchema: { type: 'object', properties: {} } },
];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
// Some servers log to stdout before the first message: the client must skip it.
process.stdout.write('fake-mcp starting\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-mcp', version: '1.0.0' }, argv: process.argv.slice(2) });
  if (m.method === 'notifications/initialized') return undefined;
  if (m.method === 'tools/list') {
    const page = m.params?.cursor === 'p2' ? tools.slice(3) : tools.slice(0, 3);
    return ok({ tools: page, ...(m.params?.cursor === 'p2' ? {} : { nextCursor: 'p2' }) });
  }
  if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params;
    if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo: ${a.text}` }] });
    if (name === 'add') return ok({ content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] });
    if (name === 'peek') return ok({ content: [{ type: 'text', text: 'seen' }] });
    if (name === 'fail') return ok({ isError: true, content: [{ type: 'text', text: 'it broke on purpose' }] });
    if (name === 'slow') { setTimeout(() => ok({ content: [{ type: 'text', text: 'late' }] }), 3000); return undefined; }
    if (name === 'picture') return ok({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });
    if (name === 'env') return ok({ content: [{ type: 'text', text: `token length ${String(process.env.FAKE_TOKEN || '').length}; args ${process.argv.slice(2).join(' ')}` }] });
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `no tool ${name}` } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
  return undefined;
});
