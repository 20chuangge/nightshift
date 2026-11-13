// A stand-in for `claude` / `codex` in the smoke test (never the real thing).
// - "auth status" / "login status": says logged in.
// - otherwise reads the task from stdin, records argv + stdin in cli-call.json
//   in the working folder, and acts on the task:
//     SLEEP  -> waits 60 s (timeout and stop tests)
//     else   -> writes hello.py and prints a Claude-style JSON result.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if ((argv[0] === 'auth' && argv[1] === 'status') || (argv[0] === 'login' && argv[1] === 'status')) {
  process.stdout.write(argv[0] === 'auth' ? '{"loggedIn": true, "authMethod": "claude.ai"}\n' : 'Logged in using ChatGPT\n');
  process.exit(0);
}
// Cursor / Qoder: "status" says who is logged in; "models" / "--list-models" list some.
if (argv[0] === 'status') {
  process.stdout.write(process.env.FAKE_CLI_LOGGED_OUT ? 'Not logged in. Run login first.\n' : 'Logged in as someone@example.com\n');
  process.exit(0);
}
if (argv[0] === 'models' || argv[0] === '--list-models') {
  process.stdout.write('Available models\n\n  auto - picks for you\n  gpt-5 (current)\n  claude-4.5-sonnet\n* Qwen3.8-Max\n\nTip: use --model <name>\n');
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const dir = argv.includes('--cd') ? argv[argv.indexOf('--cd') + 1] : process.cwd();
  fs.writeFileSync(path.join(dir, 'cli-call.json'), JSON.stringify({ argv, stdin, cwd: process.cwd() }));
  if (stdin.includes('SLEEP')) { setTimeout(() => process.exit(0), 60000); return; }
  fs.writeFileSync(path.join(dir, 'hello.py'), 'print("hello")\n');
  const o = argv.indexOf('-o');
  if (o >= 0) fs.writeFileSync(argv[o + 1], 'wrote hello.py');
  process.stdout.write('some progress\n');
  // Without --allowedTools it reports the run it was refused, as Claude Code does.
  const denials = argv.includes('--allowedTools') ? [] : [{ tool_name: 'PowerShell', tool_input: { command: 'python hello.py' } }];
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'wrote hello.py', permission_denials: denials })}\n`);
});
