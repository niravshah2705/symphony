(function () {
  const config = window.__ADLC_CONFIG__ || {};
  const tryNowUrl = typeof config.tryNowUrl === 'string' && config.tryNowUrl.trim()
    ? config.tryNowUrl.trim()
    : '/#/agent';
  const canonicalOrigin = typeof config.canonicalOrigin === 'string'
    ? config.canonicalOrigin.replace(/\/+$/, '')
    : '';

  document.querySelectorAll('[data-try-now]').forEach((link) => {
    link.setAttribute('href', tryNowUrl);
  });

  if (canonicalOrigin) {
    const canonicalUrl = `${canonicalOrigin}/adlc/`;
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', canonicalUrl);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', canonicalUrl);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/adlc/sw.js', { scope: '/adlc/' }).catch(() => {});
    });
  }
})();
