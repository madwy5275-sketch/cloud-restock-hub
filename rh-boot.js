// Classic script loaded before the page: gives the page a window.claude that waits for Firebase sign-in.
window.claude = { use: name => (window.__rhReady || new Promise(r => { const t = setInterval(() => { if (window.__rhReady) { clearInterval(t); r(window.__rhReady); } }, 30); })).then(api => api[name] || null) };
