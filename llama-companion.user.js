// ==UserScript==
// @name         llama.cpp UI Injector
// @version      0.1
// @namespace    https://github.com/ngxson/llama-companion
// @homepage     https://github.com/ngxson/llama-companion
// @license      MIT
// @description  Acts as data source for llama-server web UI
// @author       ngxson
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
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

  // llama.cpp UI detection

  async function isLlamaCppUI() {
    console.log('[llama-companion] isLlamaCppUI: checking', location.href);

    // bundle.js is loaded via <link rel="modulepreload"> + dynamic import(),
    // not a regular <script src>, so check link elements first.
    let bundleUrl = null;

    const preloads = Array.from(document.querySelectorAll('link[rel="modulepreload"]'));
    console.log('[llama-companion] modulepreload links:', preloads.map(l => l.href));
    const preload = preloads.find(l => l.href && l.href.includes('bundle.js'));
    if (preload) {
      bundleUrl = preload.href;
      console.log('[llama-companion] found bundle via modulepreload:', bundleUrl);
    }

    // Fallback: scan raw HTML for any mention of bundle.js
    if (!bundleUrl) {
      const hasInHtml = document.documentElement.innerHTML.includes('bundle.js');
      console.log('[llama-companion] "bundle.js" in innerHTML:', hasInHtml);
      if (hasInHtml) {
        const m = document.documentElement.innerHTML.match(/["'(](\.[^"'()]*bundle\.js[^"'()]*)['")\s]/);
        console.log('[llama-companion] regex match:', m && m[1]);
        if (m) bundleUrl = new URL(m[1], location.href).href;
      }
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
              name: 'get_user_context',
              description: 'Get the live context captured from the user\'s view. ALWAYS call this if you don\'t know anything about the user\'s environment, do not make assumptions. Context may change over time, you may need to call this multiple times during a session.',
              inputSchema: { type: 'object', properties: {}, required: [] },
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
        if (toolName === 'get_user_context') {
          const context = GM_getValue('userContext', '(no context available yet)');
          return buildJsonRpcResponse(id, {
            content: [{ type: 'text', text: context }],
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

  async function captureAndStore() {
    if (!document.body) return;
    const md = await elementToText(document.body);
    const context = [
      'Title: ' + document.title,
      'URL: ' + location.href,
      '',
      md,
    ].join('\n');
    GM_setValue('userContext', context);
  }

  function flashBorderGlow() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:2147483647',
      'box-shadow:inset 0 0 0 6px rgba(99,179,237,0.9)',
      'opacity:1', 'transition:opacity 250ms ease-out',
    ].join(';');
    document.documentElement.appendChild(el);
    // Trigger fade-out on next frame then remove
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { el.style.opacity = '0'; });
    });
    setTimeout(() => el.remove(), 300);
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
    document.addEventListener('dblclick', () => {
      flashBorderGlow(); // immediate visual feedback; store update is async
      captureAndStore();
    });

    document.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : '';
      if (text.length >= MIN_TEXT_SELECT_LENGTH) {
        captureAndStoreSelection(text);
        flashBorderGlow();
      }
    });

    console.log('[llama-companion] Screenshotter active on', location.href, '— double-click or select text to capture');
  }

  // Entry point

  function onDOMReady(fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
  }

  onDOMReady(async () => {
    if (await isLlamaCppUI()) {
      installMCPServerInterceptor();
    } else {
      installScreenshotter();
    }
  });

})();
