// ==UserScript==
// @name         llama.cpp UI Injector
// @version      0.3
// @namespace    https://github.com/ngxson/llama-companion
// @homepage     https://github.com/ngxson/llama-companion
// @license      MIT
// @description  Acts as data source for llama-server web UI
// @author       ngxson
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// @updateURL    https://raw.githubusercontent.com/ngxson/llama-companion/refs/heads/main/llama-companion.user.js
// @downloadURL  https://raw.githubusercontent.com/ngxson/llama-companion/refs/heads/main/llama-companion.user.js
// ==/UserScript==

(function () {
  'use strict';

  // The URL to intercept - configure this as your MCP server URL in llama.cpp UI settings
  const MOCK_MCP_SERVER = 'http://mcp.local/';

  const MIN_TEXT_SELECT_LENGTH = 128; // Minimum length of text selection to capture

  const DUCKDUCKGO_AI_MARK = 'Auto-generated based on listed sources. May contain inaccuracies.';

  // Unique ID for this tab instance, used to route MCP capture signals
  const TAB_ID = Math.random().toString(36).slice(2);

  // llama.cpp UI detection

  async function isLlamaCppUI() {
    console.log('[llama-companion] isLlamaCppUI: checking', location.href);

    // bundle.js is loaded via <link rel="modulepreload"> + dynamic import(),
    // not a regular <script src>, so check link elements first.
    let bundleUrl = null;

    // Matches plain "bundle.js" and hashed variants like "bundle.DaCibIq9.js"
    const BUNDLE_RE = /\/bundle(\.[^/.]+)?\.js/;

    const preloads = Array.from(document.querySelectorAll('link[rel="modulepreload"]'));
    console.log('[llama-companion] modulepreload links:', preloads.map(l => l.href));
    const preload = preloads.find(l => l.href && BUNDLE_RE.test(l.href));
    if (preload) {
      bundleUrl = preload.href;
      console.log('[llama-companion] found bundle via modulepreload:', bundleUrl);
    }

    // Fallback: scan raw HTML for any bundle reference
    if (!bundleUrl) {
      const m = document.documentElement.innerHTML.match(/["'(](\.\/[^"'()]*bundle(?:\.[^"'()/.]+)?\.js[^"'()]*)['")\s]/);
      console.log('[llama-companion] HTML regex match:', m && m[1]);
      if (m) bundleUrl = new URL(m[1], location.href).href;
    }

    if (!bundleUrl) {
      console.log('[llama-companion] no bundle.js URL found, not llama.cpp UI');
      return false;
    }

    console.log('[llama-companion] fetching bundle:', bundleUrl);
    try {
      const resp = await fetch(bundleUrl);
      console.log('[llama-companion] bundle fetch status:', resp.status);
      if (!resp.ok) return false;
      const text = await resp.text();
      const found = text.includes('llama-server');
      console.log('[llama-companion] "llama-server" in bundle:', found);
      return found;
    } catch (e) {
      console.log('[llama-companion] bundle fetch error:', e);
      return false;
    }
  }

  // ─── Mock MCP server (Streamable HTTP) ──────────────────────────────────────

  function buildJsonRpcResponse(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  function buildJsonRpcError(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function handleMCPRequest(init) {
    let requests;
    try {
      const body = init && init.body ? init.body : '{}';
      const parsed = JSON.parse(typeof body === 'string' ? body : await new Response(body).text());
      // Support both single requests and batched arrays
      requests = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return new Response(buildJsonRpcError(null, -32700, 'Parse error'), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Notifications have no id — respond 202 with no body when all messages are notifications
    const allNotifications = requests.every(r => r.id === undefined || r.id === null);
    if (allNotifications) {
      return new Response(null, { status: 202 });
    }

    const responses = await Promise.all(
      requests
        .filter(r => r.id !== undefined && r.id !== null)
        .map(req => dispatchMCPMethod(req))
    );

    const body = responses.length === 1
      ? responses[0]
      : '[' + responses.join(',') + ']';

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (resp) => resolve(resp.responseText),
        onerror: () => reject(new Error('Request failed for: ' + url)),
        ontimeout: () => reject(new Error('Request timed out for: ' + url)),
        timeout: 15000,
      });
    });
  }

  async function dispatchMCPMethod(req) {
    const { id, method, params } = req;

    switch (method) {
      case 'initialize':
        return buildJsonRpcResponse(id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'llama-companion', version: '0.1.0' },
        });

      case 'tools/list':
        return buildJsonRpcResponse(id, {
          tools: [
            {
              name: 'current_date',
              description: 'Current date: ' + new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
            {
              name: 'get_user_context',
              description: 'Get the live context captured from the user\'s view. ALWAYS call this if you don\'t know anything about the user\'s environment, do not make assumptions. Context may change over time, you may need to call this multiple times during a session.',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
            {
              name: 'web_search',
              description: 'Search the web, use when you are not sure about information or want to get recent news. Do NOT include user\'s personal info in the query.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'The search query' },
                },
                required: ['query'],
              },
            },
            {
              name: 'get_url',
              description: 'Fetch the raw content of any URL.',
              inputSchema: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'The URL to fetch' },
                },
                required: ['url'],
              },
            },
          ],
        });

      case 'tools/call': {
        const toolName = params && params.name;
        if (toolName === 'current_date') {
          return buildJsonRpcResponse(id, {
            content: [{ type: 'text', text: new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) }],
          });
        }
        if (toolName === 'get_user_context') {
          // Signal the last-focused screenshotter tab to capture fresh data
          const nonce = Date.now();
          GM_setValue('contextRequest', nonce);

          // Poll up to 5s for the screenshotter tab to write back
          await new Promise((resolve) => {
            const deadline = Date.now() + 5000;
            const poll = setInterval(() => {
              if (GM_getValue('contextResponseNonce', 0) === nonce || Date.now() > deadline) {
                clearInterval(poll);
                resolve();
              }
            }, 100);
          });

          const context = GM_getValue('userContext', '(no context available yet)');
          return buildJsonRpcResponse(id, {
            content: [{ type: 'text', text: context }],
          });
        }
        if (toolName === 'web_search') {
          const query = params && params.arguments && params.arguments.query;
          if (!query) return buildJsonRpcError(id, -32602, 'Missing required argument: query');
          const nonce = Date.now();
          GM_setValue('searchRequest', nonce);
          const searchUrl = 'https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&assist=true';
          GM_openInTab(searchUrl, { active: false, insert: true });

          // Wait up to 15s for the search tab to capture and write back
          await new Promise((resolve) => {
            const deadline = Date.now() + 15000;
            const poll = setInterval(() => {
              if (GM_getValue('searchResponseNonce', 0) === nonce || Date.now() > deadline) {
                clearInterval(poll);
                resolve();
              }
            }, 200);
          });

          const result = GM_getValue('searchResult', '(no search results available)');
          return buildJsonRpcResponse(id, {
            content: [{ type: 'text', text: result }],
          });
        }
        if (toolName === 'get_url') {
          const url = params && params.arguments && params.arguments.url;
          if (!url) return buildJsonRpcError(id, -32602, 'Missing required argument: url');
          try {
            const text = await gmFetch(url);
            return buildJsonRpcResponse(id, {
              content: [{ type: 'text', text: text.slice(0, 50000) }],
            });
          } catch (e) {
            return buildJsonRpcResponse(id, {
              content: [{ type: 'text', text: 'Error: ' + e.message }],
              isError: true,
            });
          }
        }
        return buildJsonRpcError(id, -32602, 'Unknown tool: ' + toolName);
      }

      case 'ping':
        return buildJsonRpcResponse(id, {});

      default:
        return buildJsonRpcError(id, -32601, 'Method not found: ' + method);
    }
  }

  function installMCPServerInterceptor() {
    // Use unsafeWindow so we patch the page's fetch, not the sandbox's fetch.
    // When Tampermonkey grants are active, `window` is a sandbox proxy — the
    // page's scripts never see overrides made to it.
    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    console.log('[llama-companion] sandbox check — same window?', pageWindow === window);

    const originalFetch = pageWindow.fetch.bind(pageWindow);

    pageWindow.fetch = function (input, init) {
      const url = input instanceof pageWindow.Request ? input.url
        : input instanceof pageWindow.URL ? input.href
        : String(input);

      console.log('[llama-companion] fetch intercepted:', url);

      if (url === MOCK_MCP_SERVER || url.startsWith(MOCK_MCP_SERVER)) {
        console.log('[llama-companion] → routing to mock MCP server');
        return handleMCPRequest(input instanceof pageWindow.Request ? input : init);
      }

      return originalFetch(input, init);
    };

    // Expose a debug helper on the page window so you can test from the console:
    //   window.__llama_get_user_context()
    pageWindow.__llama_get_user_context = function () {
      const val = GM_getValue('userContext', '(no context available yet)');
      console.log('[llama-companion] userContext =', val);
      return val;
    };

    console.log('[llama-companion] Mock MCP server active at', MOCK_MCP_SERVER);
    console.log('[llama-companion] debug: call window.__llama_get_user_context() to inspect stored context');
  }

  // Screenshotter (non-llama.cpp pages)

  const DOM_TO_MD_CDN = 'https://cdn.jsdelivr.net/npm/@alloc/dom-to-semantic-markdown/+esm';
  let _domToMdModule = null;

  async function loadDomToMd() {
    if (_domToMdModule) return _domToMdModule;
    try {
      _domToMdModule = await import(DOM_TO_MD_CDN);
      console.log('[llama-companion] dom-to-semantic-markdown loaded');
    } catch (e) {
      console.warn('[llama-companion] failed to load dom-to-semantic-markdown:', e);
      _domToMdModule = null;
    }
    return _domToMdModule;
  }

  async function elementToText(element) {
    const mod = await loadDomToMd();
    if (mod && mod.convertElementToMarkdown) {
      return mod.convertElementToMarkdown(element);
    }
    // Fallback to innerText if CDN load failed
    return element.innerText || '';
  }

  async function captureAndStore(nonce = null) {
    if (!document.body) return;
    const md = await elementToText(document.body);
    const context = [
      'Title: ' + document.title,
      'URL: ' + location.href,
      '',
      md,
    ].join('\n');
    GM_setValue('userContext', context);
    // Signal completion back to the MCP server poll
    if (nonce !== null) GM_setValue('contextResponseNonce', nonce);
  }

  function flashBorderGlow() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:2147483647',
      'box-shadow:inset 0 0 0 6px rgba(99,179,237,0.9)',
      'opacity:1', 'transition:opacity 450ms ease-out',
    ].join(';');
    document.documentElement.appendChild(el);
    // Trigger fade-out on next frame then remove
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { el.style.opacity = '0'; });
    });
    setTimeout(() => el.remove(), 500);
  }

  function captureAndStoreSelection(selectedText) {
    const context = [
      'Title: ' + document.title,
      'URL: ' + location.href,
      '',
      '[User selected text]:',
      selectedText,
    ].join('\n');
    GM_setValue('userContext', context);
  }

  function installScreenshotter() {
    // If this tab was opened by the web_search tool, auto-capture and close.
    const searchNonce = GM_getValue('searchRequest', 0);
    const searchDone = GM_getValue('searchResponseNonce', 0);
    const isRecentSearch = searchNonce && searchNonce !== searchDone && (Date.now() - searchNonce) < 30000;
    if (isRecentSearch) {
      const doSearchCapture = async () => {
      // Wait for page load
      await new Promise(resolve => {
        if (document.readyState === 'complete') resolve();
        else window.addEventListener('load', resolve, { once: true });
      });

      // Poll for the AI summary marker; fall back after 10s if it never appears.
      await new Promise(resolve => {
        const deadline = Date.now() + 10000;
        const check = setInterval(() => {
          const found = document.body && document.body.innerText.includes(DUCKDUCKGO_AI_MARK);
          if (found || Date.now() > deadline) {
            clearInterval(check);
            setTimeout(resolve, found ? 500 : 0);
          }
        }, 200);
      });

      const md = await elementToText(document.body);
      const content = ['Title: ' + document.title, 'URL: ' + location.href, '', md].join('\n');
      GM_setValue('searchResult', content);
      GM_setValue('searchResponseNonce', searchNonce);
      window.close();
    };

      doSearchCapture();
      return; // skip normal screenshotter setup
    }

    // Register this tab as the last-active screenshotter tab now and on every focus.
    // The MCP signal handler below uses this to decide which tab should respond.
    // When the user switches from this tab to llama-ui, this tab's ID remains
    // stored — so the MCP capture signal correctly targets it.
    const registerAsActive = () => GM_setValue('lastActiveTab', TAB_ID);
    registerAsActive();
    window.addEventListener('focus', registerAsActive);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) registerAsActive();
    });

    // React to MCP-triggered capture requests
    GM_addValueChangeListener('contextRequest', async (_name, _oldVal, newVal, remote) => {
      if (!remote) return; // ignore writes from this same tab
      if (GM_getValue('lastActiveTab') !== TAB_ID) return; // not our turn
      flashBorderGlow();
      await captureAndStore(newVal); // newVal is the nonce
    });

    // Manual capture via text selection
    document.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : '';
      if (text.length >= MIN_TEXT_SELECT_LENGTH) {
        captureAndStoreSelection(text);
        flashBorderGlow();
      }
    });

    console.log('[llama-companion] Screenshotter active on', location.href, '— double-click or select ≥128 chars to capture');
  }

  // Entry point

  function onDOMReady(fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
  }

  function isLocalPage() {
    const h = location.hostname;
    return h === 'localhost'
      || h === '127.0.0.1'
      || h === '::1'
      || h.endsWith('.local')
      || h.endsWith('.localhost');
  }

  onDOMReady(async () => {
    if (isLocalPage() && await isLlamaCppUI()) {
      installMCPServerInterceptor();
    } else {
      installScreenshotter();
    }
  });

})();
