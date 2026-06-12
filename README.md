# llama-companion

Turns [llama.cpp's web UI](https://github.com/ggml-org/llama.cpp) into agentic browser **without** using an external MCP server.

All done via a Tampermonkey userscript that gives the web UI a live browser context via a fake in-browser MCP server.

## How it works

The script detects which kind of page it is running on and activates one of two modes:
- **llama.cpp UI mode**: intercepts `fetch()` to expose a fake MCP server at `http://mcp.local/`. This is a in-browser trick, NO external server is required.
- **Screenshotter mode**: runs on every other page and captures content into shared userscript storage (`GM_setValue`), making it instantly available to the MCP server.

## Installation

Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.

Then, click on this link to trigger the installation: https://raw.githubusercontent.com/ngxson/llama-companion/refs/heads/main/llama-companion.user.js

Alternatively:
- Create a new userscript and paste the contents of [llama-companion.user.js](llama-companion.user.js).
- Save and enable the script.

## Setup in llama.cpp UI

Open **Settings --> MCP Servers** and add a new server with the URL:

```
http://mcp.local/
```

Enable the server. The script intercepts all requests to that URL - nothing actually listens on that address.

## Capturing content (screenshotter mode)

On any non-llama.cpp page, two gestures trigger a capture (a blue border glow confirms it ran):

| Gesture | What is captured |
|---------|-----------------|
| **Double-click** anywhere | Full page `innerText` (up to 20 000 chars) |
| **Select text** (≥ 128 chars) | The selected text only |

The captured content is stored immediately and available to the LLM the next time it calls `get_user_context`.

## Debugging

On the llama.cpp page, open the browser console and call:

```js
window.__llama_get_user_context()
```

This prints and returns whatever is currently stored in GM storage, independently of the MCP machinery.
