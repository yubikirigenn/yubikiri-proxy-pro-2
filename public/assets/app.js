(() => {
  // The page is never touched: no padding, no layout reservation, no cursor
  // tracking. One small pull tab does everything: click to open the toolbar,
  // click again to close it. While the bar is open the tab hangs from its
  // bottom edge, so the button never moves away. The tab can be grabbed and
  // slid along the top area - the position is remembered.
  const setupToolbarToggle = () => {
    const toolbar = document.getElementById('yubikiri-proxy-toolbar');
    const toggle = document.getElementById('yubikiri-proxy-toggle');
    if (!toolbar || !toggle) return;

    const root = document.documentElement;
    const POS_KEY = 'yubikiri-toggle-pos';
    const TOP_LIMIT = 60;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const isOpen = () => root.classList.contains('yubikiri-bar-open');

    let drag = null;          // {id, dx, dy, startLeft, startTop, moved, open}
    let suppressClick = false;
    let pos = { l: 0, t: 0 }; // 閉じているときの居座り位置

    const place = (left, top) => {
      toggle.style.left = Math.round(left) + 'px';
      toggle.style.top = Math.round(top) + 'px';
    };
    const placeClosed = () => {
      pos.l = clamp(pos.l, 0, window.innerWidth - toggle.offsetWidth);
      pos.t = clamp(pos.t, 0, TOP_LIMIT);
      place(pos.l, pos.t);
    };
    // 開いているときはバーの下端に吸着させる。offsetHeight は transform の
    // アニメーション中でも確定したレイアウト上の高さを返す
    const placeOpen = () => {
      place(clamp(pos.l, 0, window.innerWidth - toggle.offsetWidth), toolbar.offsetHeight);
    };
    const syncToggle = () => {
      const open = isOpen();
      toggle.textContent = open ? '▴' : '▾';
      const label = open ? 'Yubikiri Proxyのバーを閉じる' : 'Yubikiri Proxyのバーを開く';
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
      toggle.setAttribute('aria-expanded', String(open));
      if (open) placeOpen(); else placeClosed();
    };

    // 居座り位置の復元（無ければ左はじの既定位置）
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (saved && Number.isFinite(saved.l) && Number.isFinite(saved.t)) pos = { l: saved.l, t: saved.t };
    } catch {}
    syncToggle();

    const close = () => { root.classList.remove('yubikiri-bar-open'); syncToggle(); };
    const open = () => { root.classList.add('yubikiri-bar-open'); syncToggle(); };

    toggle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = toggle.getBoundingClientRect();
      drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, startLeft: rect.left, startTop: rect.top, moved: false, open: isOpen() };
      toggle.classList.add('yubikiri-toggle-dragging');
      toggle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    toggle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const left = event.clientX - drag.dx;
      const top = event.clientY - drag.dy;
      if (!drag.moved && (Math.abs(left - drag.startLeft) > 3 || Math.abs(top - drag.startTop) > 3)) drag.moved = true;
      if (!drag.moved) return;
      pos.l = clamp(left, 0, window.innerWidth - toggle.offsetWidth);
      if (drag.open) placeOpen();
      else {
        pos.t = clamp(top, 0, TOP_LIMIT);
        place(pos.l, pos.t);
      }
      suppressClick = true;
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      toggle.classList.remove('yubikiri-toggle-dragging');
      if (moved) {
        try { localStorage.setItem(POS_KEY, JSON.stringify({ l: pos.l, t: pos.t })); } catch {}
        window.setTimeout(() => { suppressClick = false; }, 0);
      }
    };
    toggle.addEventListener('pointerup', endDrag);
    toggle.addEventListener('pointercancel', endDrag);

    // クリック判定は document に委譲する。サイト側が取得したHTMLを innerHTML
    // 経由で差し込み直すとツールバー/トグルが複製されることがあり、表示上の
    // 最前面の複製には個別リスナーが付かない。委譲ならどの複製でも開閉できる。
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('#yubikiri-proxy-toggle') : null;
      if (!target) return;
      if (suppressClick) { suppressClick = false; return; }
      if (isOpen()) close();
      else open();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen()) close();
    });
    document.addEventListener('click', (event) => {
      if (!isOpen()) return;
      if (event.target instanceof Element && event.target.closest('#yubikiri-proxy-toolbar, #yubikiri-proxy-toggle')) return;
      close();
    });
    window.addEventListener('resize', () => { if (isOpen()) placeOpen(); else placeClosed(); });
  };

  setupToolbarToggle();

  const resetForms = () => {
    for (const form of document.querySelectorAll('[data-proxy-form]')) {
      const button = form.querySelector('button[type="submit"]');
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    }
  };

  // A page restored from the back/forward cache keeps its previous DOM state.
  window.addEventListener('pageshow', resetForms);
  resetForms();

  const forms = document.querySelectorAll('[data-proxy-form]');

  for (const form of forms) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.querySelector('input[name="url"]');
      const button = form.querySelector('button[type="submit"]');
      const error = document.querySelector('[data-form-error]');
      const url = input?.value.trim();
      if (!url) return;

      if (error) error.textContent = '';
      if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
      }

      // プロキシ配下では site 側ランタイムが window.fetch を /proxy/<site> に
      // 書き換えるため、相対 '/api/navigate' はサイト宛て(404)になる。
      // アプリ自身のオリジンへ絶対URLで送る。アプリオリジンの /api/ は
      // ランタイム側でも書き換え対象外。どのページでも同じ方式(POSTして
      // 結果の /proxy/ パスへ直接遷移)を使い、アドレスバーに
      // /api/navigate の中間URLを出さない。
      try {
        let response;
        try {
          response = await window.fetch(new URL('/api/navigate', window.location.origin).href, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url })
          });
        } catch {
          // fetch自体が失敗した場合のみ、GETリダイレクト方式へフォールバック。
          if (window.__YUBIKIRI_UPSTREAM_URL__) {
            const destination = new URL('/api/navigate', window.location.origin);
            destination.searchParams.set('url', url);
            // Do not leave the API redirect in browser history. Otherwise Back
            // immediately redirects to the same proxied page again.
            window.location.replace(destination.href);
            return;
          }
          throw new Error('ページを開けませんでした');
        }
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.path) throw new Error(result?.error || 'URLを確認してください');
        window.location.assign(result.path);
      } catch (cause) {
        if (error) error.textContent = cause instanceof Error ? cause.message : 'ページを開けませんでした';
        if (button) {
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
        input?.focus();
      }
    });
  }
})();
