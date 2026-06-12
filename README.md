# llama-companion

Turns [llama.cpp's web UI](https://github.com/ggml-org/llama.cpp) into agentic browser **without** using an external MCP server.

All done via a Tampermonkey userscript that gives the web UI a live browser context via a fake in-browser MCP server.

## How it works

The script detects which kind of page it is running on and activates one of two modes:
- **llama.cpp UI mode**: intercepts `fetch()` to expose a fake MCP server at `http://mcp.local/`. This is an in-browser trick — NO external server is required. Only activates on local pages (`localhost`, `127.0.0.1`, `*.local`, etc.) for security.
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

## MCP tools

| Tool | Description |
|------|-------------|
| `current_date` | Returns the current date in local format. The date is also visible directly in the tool description, so the LLM may not need to call it at all. |
| `get_user_context` | Signals the last-focused browser tab to capture its content and returns it as markdown. Waits up to 5s for the response. **If multiple tabs are open**, whichever tab was focused most recently before switching to llama-ui is the one that responds. |
| `web_search` | Opens a background DuckDuckGo tab, waits for the AI summary to appear, captures the results as markdown, then closes the tab. |
| `get_url` | Fetches the raw content of any URL, bypassing CORS via the userscript layer. |

## Web search

`web_search` opens DuckDuckGo in a background tab and polls the page until the AI-generated summary appears (detected by a known marker string). Once found it waits 500ms for rendering to settle, converts the page to markdown, writes the result back, and closes the tab. Times out after 10s if no summary appears.

## Capturing content (screenshotter mode)

Content is captured automatically when the LLM calls `get_user_context`. You can also manually capture by selecting ≥ 128 characters of text — a blue border glow confirms it ran.

Page content is converted to semantic markdown using [`@alloc/dom-to-semantic-markdown`](https://www.npmjs.com/package/@alloc/dom-to-semantic-markdown), loaded lazily from jsDelivr on first capture. Falls back to `innerText` if the CDN is unreachable.

## Debugging

On the llama.cpp page, open the browser console and call:

```js
window.__llama_get_user_context()
```

This prints and returns whatever is currently stored in GM storage, independently of the MCP machinery.

## Requirements

- Tampermonkey (Chrome, Firefox, Edge, Safari)
- llama.cpp built with the web UI (`llama-server --port 8080 ...`)
