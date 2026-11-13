/**
 * Fake IMAP and SMTP servers for the smoke test (plain TCP on 127.0.0.1).
 * Just enough of each protocol for mail.mjs: greeting, LOGIN, ID, LIST,
 * EXAMINE/SELECT, FETCH, UID SEARCH (with a literal), UID FETCH, UID STORE,
 * LOGOUT; EHLO, AUTH PLAIN, MAIL/RCPT/DATA, QUIT.
 */
import net from 'node:net';

export async function fakeImap({ user, pass, messages }) {
  const log = [];
  const srv = net.createServer((sock) => {
    sock.write('* OK fake IMAP ready\r\n');
    let buf = '';
    let pendingLiteral = null; // {tag, cmd, need}
    const reply = (t) => sock.write(`${t}\r\n`);
    const handle = (tag, cmd) => {
      log.push(cmd);
      if (/^LOGIN /i.test(cmd)) {
        const m = cmd.match(/^LOGIN "([^"]*)" "([^"]*)"/i);
        if (m && m[1] === user && m[2] === pass) reply(`${tag} OK logged in`); else reply(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
      } else if (/^ID /i.test(cmd)) { reply('* ID NIL'); reply(`${tag} OK ID done`); }
      else if (/^LIST /i.test(cmd)) {
        reply('* LIST (\\HasNoChildren) "/" "INBOX"');
        reply('* LIST (\\HasNoChildren \\Sent) "/" "&XfJT0ZAB-"');
        reply('* LIST (\\Noselect) "/" "[Gmail]"');
        reply(`${tag} OK LIST done`);
      } else if (/^(EXAMINE|SELECT) /i.test(cmd)) { reply(`* ${messages.length} EXISTS`); reply(`${tag} OK [READ-WRITE] done`); }
      else if (/^(UID )?FETCH /i.test(cmd)) {
        const uidMode = /^UID /i.test(cmd);
        const set = cmd.split(' ')[uidMode ? 2 : 1];
        const pick = set.includes(':') ? (() => { const [a, b] = set.split(':').map(Number); return messages.filter((_, i) => i + 1 >= a && i + 1 <= b); })()
          : set.split(',').map(Number).map((n) => (uidMode ? messages.find((m) => m.uid === n) : messages[n - 1])).filter(Boolean);
        for (const m of pick) {
          const seq = messages.indexOf(m) + 1;
          const flags = m.seen ? '\\Seen' : '';
          if (/BODY\.PEEK\[\]/i.test(cmd)) {
            sock.write(`* ${seq} FETCH (UID ${m.uid} FLAGS (${flags}) BODY[] {${m.raw.length}}\r\n`);
            sock.write(m.raw);
            sock.write(')\r\n');
          } else {
            const head = m.raw.subarray(0, m.raw.indexOf('\r\n\r\n') + 4);
            sock.write(`* ${seq} FETCH (UID ${m.uid} FLAGS (${flags}) INTERNALDATE "13-Nov-2026 10:00:00 +0800" RFC822.SIZE ${m.raw.length} BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)] {${head.length}}\r\n`);
            sock.write(head);
            sock.write(')\r\n');
          }
        }
        reply(`${tag} OK FETCH done`);
      } else if (/^UID SEARCH/i.test(cmd)) {
        let hits = messages;
        if (/UNSEEN/i.test(cmd)) hits = hits.filter((m) => !m.seen);
        const subj = cmd.match(/SUBJECT \u0000(.*?)\u0000/);
        if (subj) hits = hits.filter((m) => m.subject.includes(subj[1]));
        const from = cmd.match(/FROM "([^"]*)"/i);
        if (from) hits = hits.filter((m) => m.from.includes(from[1]));
        reply(`* SEARCH ${hits.map((m) => m.uid).join(' ')}`);
        reply(`${tag} OK SEARCH done`);
      } else if (/^UID STORE/i.test(cmd)) {
        const uids = cmd.split(' ')[2].split(',').map(Number);
        for (const m of messages) if (uids.includes(m.uid)) m.seen = /\+FLAGS/i.test(cmd);
        reply(`${tag} OK STORE done`);
      } else if (/^LOGOUT/i.test(cmd)) { reply('* BYE'); reply(`${tag} OK bye`); sock.end(); }
      else reply(`${tag} BAD unknown`);
    };
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (pendingLiteral) {
          const bytes = Buffer.from(buf, 'utf8');
          if (bytes.length < pendingLiteral.need) return;
          const lit = bytes.subarray(0, pendingLiteral.need).toString('utf8');
          buf = bytes.subarray(pendingLiteral.need).toString('utf8');
          pendingLiteral.cmd += `\u0000${lit}\u0000`;
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const rest = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const p = pendingLiteral;
          pendingLiteral = null;
          p.cmd += rest;
          const more = rest.match(/\{(\d+)\}$/);
          if (more) { pendingLiteral = { tag: p.tag, cmd: p.cmd.replace(/\{\d+\}$/, ''), need: Number(more[1]) }; sock.write('+ go on\r\n'); continue; }
          handle(p.tag, p.cmd);
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const sp = line.indexOf(' ');
        const tag = line.slice(0, sp);
        const cmd = line.slice(sp + 1);
        const lit = cmd.match(/\{(\d+)\}$/);
        if (lit) { pendingLiteral = { tag, cmd: cmd.replace(/\{\d+\}$/, ''), need: Number(lit[1]) }; sock.write('+ go on\r\n'); continue; }
        handle(tag, cmd);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, log, close: () => srv.close() };
}

export async function fakeSmtp({ user, pass }) {
  const sent = [];
  const srv = net.createServer((sock) => {
    sock.write('220 fake SMTP\r\n');
    let buf = '';
    let data = null;
    let env = { from: '', to: [] };
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          sent.push({ ...env, data: data.replace(/^\.\./gm, '.') });
          data = null;
          env = { from: '', to: [] };
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          sock.write(u === user && p === pass ? '235 ok\r\n' : '535 Error: authentication failed\r\n');
        } else if (/^MAIL FROM:/i.test(line)) { env.from = line.slice(10).replace(/[<>]/g, ''); sock.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { env.to.push(line.slice(8).replace(/[<>]/g, '')); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { data = ''; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 no\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, sent, close: () => srv.close() };
}
