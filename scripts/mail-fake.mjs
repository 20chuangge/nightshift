/**
 * Fake IMAP and SMTP servers for the smoke test (plain TCP on 127.0.0.1).
 * Just enough of each protocol for mail.mjs: greeting, LOGIN, ID, LIST,
 * EXAMINE/SELECT, FETCH, UID SEARCH (with a literal), UID FETCH, UID STORE,
 * LOGOUT; EHLO, AUTH PLAIN, MAIL/RCPT/DATA, QUIT.
 */
import net from 'node:net';

export async function fakeImap({ user, pass, messages, caps = 'IMAP4rev1 MOVE UIDPLUS' }) {
  const log = [];
  // Folders by their wire (modified UTF-7) name: 已删除 = &XfJSIJZk-, 垃圾邮件 = &V4NXPpCuTvY-.
  const folders = { INBOX: messages, '&XfJT0ZAB-': [], '&XfJSIJZk-': [], '&V4NXPpCuTvY-': [] };
  const srv = net.createServer((sock) => {
    sock.write('* OK fake IMAP ready\r\n');
    let cur = 'INBOX';
    const box = () => folders[cur] || [];
    const setOf = (cmd) => cmd.split(' ')[2].split(',').map(Number);
    const target = (cmd) => (cmd.match(/"([^"]*)"\s*$/) || [])[1];
    let buf = '';
    let pendingLiteral = null; // {tag, cmd, need}
    const reply = (t) => sock.write(`${t}\r\n`);
    const handle = (tag, cmd) => {
      log.push(cmd);
      if (/^LOGIN /i.test(cmd)) {
        const m = cmd.match(/^LOGIN "([^"]*)" "([^"]*)"/i);
        if (m && m[1] === user && m[2] === pass) reply(`${tag} OK logged in`); else reply(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
      } else if (/^ID /i.test(cmd)) { reply('* ID NIL'); reply(`${tag} OK ID done`); }
      else if (/^CAPABILITY/i.test(cmd)) { reply(`* CAPABILITY ${caps}`); reply(`${tag} OK done`); }
      else if (/^LIST /i.test(cmd)) {
        reply('* LIST (\\HasNoChildren) "/" "INBOX"');
        reply('* LIST (\\HasNoChildren \\Sent) "/" "&XfJT0ZAB-"');
        reply('* LIST (\\HasNoChildren \\Trash) "/" "&XfJSIJZk-"');
        reply('* LIST (\\HasNoChildren \\Junk) "/" "&V4NXPpCuTvY-"');
        reply('* LIST (\\Noselect) "/" "[Gmail]"');
        reply(`${tag} OK LIST done`);
      } else if (/^(EXAMINE|SELECT) /i.test(cmd)) { cur = (cmd.match(/"([^"]*)"/) || [])[1] || 'INBOX'; reply(`* ${box().length} EXISTS`); reply(`${tag} OK [READ-WRITE] done`); }
      else if (/^UID MOVE /i.test(cmd) && /MOVE/.test(caps)) {
        const uids = setOf(cmd); const to = target(cmd);
        folders[to] = folders[to] || [];
        for (const m of box().filter((x) => uids.includes(x.uid))) folders[to].push(m);
        folders[cur] = box().filter((x) => !uids.includes(x.uid));
        reply(`${tag} OK MOVE done`);
      } else if (/^UID COPY /i.test(cmd)) {
        const uids = setOf(cmd); const to = target(cmd);
        folders[to] = folders[to] || [];
        for (const m of box().filter((x) => uids.includes(x.uid))) folders[to].push({ ...m });
        reply(`${tag} OK COPY done`);
      } else if (/^UID STORE .*\\Deleted/i.test(cmd)) {
        const uids = setOf(cmd);
        for (const m of box()) if (uids.includes(m.uid)) m.deleted = true;
        reply(`${tag} OK STORE done`);
      } else if (/^(UID )?EXPUNGE/i.test(cmd)) {
        const only = /^UID /i.test(cmd) ? setOf(cmd) : null;
        folders[cur] = box().filter((m) => !(m.deleted && (!only || only.includes(m.uid))));
        reply(`${tag} OK EXPUNGE done`);
      }
      else if (/^(UID )?FETCH /i.test(cmd)) {
        const uidMode = /^UID /i.test(cmd);
        const set = cmd.split(' ')[uidMode ? 2 : 1];
        const pick = set.includes(':') ? (() => { const [a, b] = set.split(':').map(Number); return box().filter((_, i) => i + 1 >= a && i + 1 <= b); })()
          : set.split(',').map(Number).map((n) => (uidMode ? box().find((m) => m.uid === n) : box()[n - 1])).filter(Boolean);
        for (const m of pick) {
          const seq = box().indexOf(m) + 1;
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
        let hits = box();
        if (/UNSEEN/i.test(cmd)) hits = hits.filter((m) => !m.seen);
        const subj = cmd.match(/SUBJECT \u0000(.*?)\u0000/);
        if (subj) hits = hits.filter((m) => m.subject.includes(subj[1]));
        const from = cmd.match(/FROM "([^"]*)"/i);
        if (from) hits = hits.filter((m) => m.from.includes(from[1]));
        reply(`* SEARCH ${hits.map((m) => m.uid).join(' ')}`);
        reply(`${tag} OK SEARCH done`);
      } else if (/^UID STORE/i.test(cmd)) {
        const uids = cmd.split(' ')[2].split(',').map(Number);
        for (const m of box()) if (uids.includes(m.uid)) m.seen = /\+FLAGS/i.test(cmd);
        reply(`${tag} OK STORE done`);
      } else if (/^LOGOUT/i.test(cmd)) { reply('* BYE'); reply(`${tag} OK bye`); sock.end(); }
      else reply(`${tag} BAD unknown`);
    };
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (pendingLiteral) {
          // The literal and the line end may arrive in separate packets (Linux
          // does that on loopback): take the literal once, then wait for the line end.
          if (pendingLiteral.need) {
            const bytes = Buffer.from(buf, 'utf8');
            if (bytes.length < pendingLiteral.need) return;
            const lit = bytes.subarray(0, pendingLiteral.need).toString('utf8');
            buf = bytes.subarray(pendingLiteral.need).toString('utf8');
            pendingLiteral.cmd += `\u0000${lit}\u0000`;
            pendingLiteral.need = 0;
          }
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
  return { port: srv.address().port, log, folders, close: () => srv.close() };
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
