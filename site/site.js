// Lamplit site: theme switch, newest downloads, gentle reveal, docs contents.
(() => {
  const root = document.documentElement;
  const KEY = 'evenlight.theme';
  try { const t = localStorage.getItem(KEY); if (t === 'light' || t === 'dark') root.dataset.theme = t; } catch { /* private window */ }
  document.getElementById('theme')?.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem(KEY, root.dataset.theme); } catch { /* not kept */ }
  });

  // Point the buttons straight at the newest files; the release page stays the fallback.
  // Installers were named Nightshift-* before 1.2.146 and Evenlight-* until 1.2.149.
  (async () => {
    try {
      const res = await fetch('https://api.github.com/repos/20chuangge/lamplit/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const rel = await res.json();
      const find = (re) => (rel.assets || []).find((a) => re.test(a.name));
      const setup = find(/^(Lamplit|Evenlight|Nightshift)-Setup-.*\.exe$/);
      const apk = find(/^(Lamplit|Evenlight|Nightshift)-Android-.*\.apk$/);
      const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;
      const a = document.getElementById('dl-setup');
      if (setup && a) {
        a.href = setup.browser_download_url;
        document.getElementById('dl-version').textContent = ` ${rel.tag_name}`;
        document.getElementById('dl-size').textContent = `Windows 10 / 11 · 64 位 · ${mb(setup.size)}`;
      }
      const b = document.getElementById('dl-apk');
      if (apk && b) b.href = apk.browser_download_url;
    } catch { /* keep the release-page links */ }
  })();

  // Sections fade in once as they scroll into view.
  const targets = document.querySelectorAll('section:not(.hero) .wrap');
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    for (const t of targets) { t.classList.add('reveal'); io.observe(t); }
  }

  // Docs: highlight the section being read.
  const links = [...document.querySelectorAll('.toc a')];
  if (links.length && 'IntersectionObserver' in window) {
    const byId = new Map(links.map((l) => [l.getAttribute('href').slice(1), l]));
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((l) => l.classList.remove('on'));
        byId.get(e.target.id)?.classList.add('on');
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('.doc h2[id]').forEach((h) => spy.observe(h));
  }
})();
