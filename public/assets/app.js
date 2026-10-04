(() => {
  // The toolbar permanently reserves the top 58px of the page: body padding
  // moves normal content down, and headers pinned with position:fixed/sticky
  // at the very top (Apple's JP nav etc.) are shifted below the bar too.
  // Nothing is overlaid and the layout never shifts afterwards.
  const setupToolbarSpace = () => {
    const toolbar = document.getElementById('yubikiri-proxy-toolbar');
    if (!toolbar) return;

    const pushedClass = 'yubikiri-bar-pushed';
    const pushTopPinned = () => {
      for (const el of document.body.querySelectorAll('*')) {
        if (el === toolbar || toolbar.contains(el) || el.classList.contains(pushedClass)) continue;
        const cs = getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'sticky') && cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().top <= 2) {
          el.classList.add(pushedClass);
        }
      }
    };

    pushTopPinned();
    // SPAs turn headers fixed (or replace nodes) after load, and scrolling
    // brings sticky headers to the top - keep the reserve up to date.
    window.setInterval(pushTopPinned, 800);
    window.addEventListener('pageshow', pushTopPinned);
  };

  setupToolbarSpace();

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
