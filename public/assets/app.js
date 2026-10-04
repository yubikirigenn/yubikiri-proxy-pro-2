(() => {
  // The page is never touched: no padding, no layout reservation, no cursor
  // tracking. A small pull tab at the top edge toggles the toolbar; the bar
  // closes via its ✕, an outside click, or Escape.
  const setupToolbarToggle = () => {
    const toolbar = document.getElementById('yubikiri-proxy-toolbar');
    const toggle = document.getElementById('yubikiri-proxy-toggle');
    if (!toolbar || !toggle) return;

    const root = document.documentElement;
    const close = () => {
      root.classList.remove('yubikiri-bar-open');
      toggle.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      root.classList.add('yubikiri-bar-open');
      toggle.setAttribute('aria-expanded', 'true');
    };

    toggle.addEventListener('click', () => {
      if (root.classList.contains('yubikiri-bar-open')) close();
      else open();
    });
    const closeButton = toolbar.querySelector('.yubikiri-bar-close');
    if (closeButton) closeButton.addEventListener('click', close);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('yubikiri-bar-open')) close();
    });
    document.addEventListener('click', (event) => {
      if (!root.classList.contains('yubikiri-bar-open')) return;
      if (toolbar.contains(event.target) || toggle.contains(event.target)) return;
      close();
    });
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
