(() => {
  // The toolbar stays out of the way by default and slides down when the
  // pointer comes near the top edge (or the grip is tapped on touch screens).
  const setupToolbarVisibility = () => {
    const toolbar = document.getElementById('yubikiri-proxy-toolbar');
    const grip = document.getElementById('yubikiri-proxy-grip');
    if (!toolbar || !grip) return;

    const root = document.documentElement;
    let hideTimer = 0;
    const isVisible = () => root.classList.contains('yubikiri-bar-visible');
    const show = () => {
      window.clearTimeout(hideTimer);
      root.classList.add('yubikiri-bar-visible');
    };
    const hideSoon = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (toolbar.contains(document.activeElement)) return;
        root.classList.remove('yubikiri-bar-visible');
      }, 450);
    };

    document.addEventListener('mousemove', (event) => {
      if (event.clientY <= 28) {
        if (!isVisible()) show();
        return;
      }
      if (!isVisible()) return;
      // 要素判定にすることで、ツールバーの外に出したエラー表示の上では消えない
      const over = document.elementFromPoint(event.clientX, event.clientY);
      if (over && toolbar.contains(over)) return;
      hideSoon();
    }, { passive: true });
    toolbar.addEventListener('focusin', show);
    toolbar.addEventListener('focusout', hideSoon);
    grip.addEventListener('click', show);
    document.addEventListener('click', (event) => {
      if (!isVisible()) return;
      if (toolbar.contains(event.target) || grip.contains(event.target)) return;
      hideSoon();
    });
  };

  setupToolbarVisibility();

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
      if (window.__YUBIKIRI_UPSTREAM_URL__) {
        if (button) {
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
        }
        const destination = new URL('/api/navigate', window.location.origin);
        destination.searchParams.set('url', url);
        // Do not leave the API redirect in browser history. Otherwise Back
        // immediately redirects to the same proxied page again.
        window.location.replace(destination.href);
        return;
      }
      if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
      }

      try {
        const response = await window.fetch('/api/navigate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'URLを確認してください');
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
