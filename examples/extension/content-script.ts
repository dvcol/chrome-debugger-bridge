(() => {
  const { chrome } = globalThis;

  let notification: HTMLDivElement | undefined;

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (message === null || typeof message !== 'object' || !('kind' in message) || message.kind !== 'example.notifications' || !('requests' in message) || !Array.isArray(message.requests)) return;
    notification?.remove();
    const request: unknown = message.requests[0];
    if (request === null || typeof request !== 'object' || !('id' in request) || typeof request.id !== 'string') return;
    notification = document.createElement('div');
    notification.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647';
    const panel = notification.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.style.cssText = 'font:14px system-ui;padding:12px;border:1px solid #4664ad;border-radius:8px;background:white;color:#172033';
    button.textContent = 'An agent requests browser access. Review in the extension.';
    button.addEventListener('click', () => void chrome.runtime.sendMessage({ kind: 'cdb.approval.request', requestId: request.id }));
    panel.append(button);
    document.documentElement.append(notification);
  });

  /** The page may request review. The service worker rejects authority-bearing messages from this tab sender. */
  window.addEventListener('message', (event) => {
    const message: unknown = event.data;
    if (event.source !== window || event.origin !== location.origin || message === null || typeof message !== 'object'
      || !('kind' in message) || typeof message.kind !== 'string' || !message.kind.startsWith('cdb.approval.')
      || !('requestId' in message) || typeof message.requestId !== 'string') return;
    void chrome.runtime.sendMessage(message).then((result: unknown) => {
      window.postMessage({ kind: 'example.approval.result', requestId: message.requestId, result }, location.origin);
    });
  });
})();
