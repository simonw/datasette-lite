# Datasette-Lite CSS and JavaScript Fixes

## Overview

This document describes the investigation and fixes implemented for two issues in datasette-lite:
1. CSS not being loaded from Datasette's internal `/-/static/app.css` path
2. JavaScript in pages served from Datasette not being executed

## Architecture Background

Datasette-lite runs entirely in the browser using Pyodide (Python compiled to WebAssembly). The architecture is:

1. `index.html` - The main page that loads in the browser
2. `webworker.js` - A Web Worker that runs Pyodide and Datasette
3. Communication happens via `postMessage` between the main thread and the worker

When a user navigates within datasette-lite:
1. The main thread sends a path request to the worker
2. The worker fetches the response from Datasette (running in Pyodide)
3. The worker sends the HTML response back
4. The main thread injects the HTML into `#output` using `innerHTML`

## Issue 1: CSS Not Loading

### Problem

Datasette's HTML responses include CSS references like:
```html
<link rel="stylesheet" href="/-/static/app.css?d59929">
```

When this HTML is injected into `index.html`, the browser tries to load `/-/static/app.css` from the static file server (e.g., `http://localhost:8123/-/static/app.css`), which doesn't exist because the static file server only serves the files in the repo root, not Datasette's internal static files.

Additionally, some pages include extra CSS files like:
```html
<link rel="stylesheet" href="/-/static/codemirror-5.57.0.min.css">
```

### Approaches Considered

1. **Service Worker Proxy**: Register a Service Worker that intercepts requests to `/-/static/*` and fetches them from Pyodide/Datasette. This would be elegant but adds complexity with Service Worker lifecycle management.

2. **Pre-fetching and Inlining**: Fetch CSS from Datasette during initialization and inline it into the HTML responses. This is simpler and more reliable.

3. **External CSS file sync**: Periodically sync the `app.css` file in the repo with Datasette's version. This requires manual maintenance and doesn't handle additional CSS files.

### Solution Implemented

We implemented approach #2 - Pre-fetching and inlining:

1. **In `webworker.js`**: After Datasette starts up, fetch the main CSS from `/-/static/app.css`:
   ```python
   css_response = await ds.client.get("/-/static/app.css")
   datasette_css = css_response.text
   ```

2. **On each HTML response**:
   - Remove the `<link>` tag for `app.css` from the HTML
   - Send the CSS content separately to the main thread
   - For additional CSS files (like CodeMirror), fetch and inline them as `<style>` tags

3. **In `index.html`**: Inject the CSS once when the first HTML response arrives:
   ```javascript
   function injectDatasetteCSS(css) {
     if (datasetteCssInjected || !css) return;
     const style = document.createElement('style');
     style.id = 'datasette-injected-css';
     style.textContent = css;
     document.head.appendChild(style);
     datasetteCssInjected = true;
   }
   ```

## Issue 2: JavaScript Not Executing

### Problem

When HTML containing `<script>` tags is set via `innerHTML`, the scripts don't execute. This is a browser security feature - dynamically inserted scripts via `innerHTML` are parsed but not executed.

Datasette pages include various JavaScript:
- Inline scripts for UI functionality (dropdown menus, etc.)
- External scripts from `/-/static/` (CodeMirror, sql-formatter, table.js)

### Approaches Considered

1. **DOMParser + appendChild**: Parse HTML with DOMParser, then manually append elements. Scripts in appended elements do execute, but this is more complex and might break existing event handlers.

2. **createContextualFragment**: Use `document.createRange().createContextualFragment()` which can execute scripts, but behavior varies across browsers.

3. **Script replacement**: After `innerHTML`, find all `<script>` elements, create new script elements with the same content, and replace the old ones. The new elements will execute.

4. **eval()**: Extract script content and use `eval()`. Security concerns and scope issues make this problematic.

### Solution Implemented

We implemented approach #3 - Script replacement, combined with inlining external scripts:

1. **In `webworker.js`**: Convert external scripts from `/-/static/` to inline scripts:
   ```python
   script_pattern = r'<script([^>]+)src="(/-/static/[^"]+)"([^>]*)></script>'

   async def replace_script(match):
       script_response = await ds.client.get(src)
       script_content = script_response.text
       # Remove defer/async as they don't apply to inline scripts
       return f'<script{attrs}>{script_content}</script>'
   ```

2. **In `index.html`**: After setting `innerHTML`, execute scripts by replacing them:
   ```javascript
   function executeScripts(container) {
     const scripts = container.querySelectorAll('script');
     scripts.forEach(oldScript => {
       const newScript = document.createElement('script');
       // Copy attributes
       Array.from(oldScript.attributes).forEach(attr => {
         newScript.setAttribute(attr.name, attr.value);
       });
       // Copy content
       newScript.textContent = oldScript.textContent;
       // Replace to trigger execution
       oldScript.parentNode.replaceChild(newScript, oldScript);
     });
   }
   ```

### Why This Works

When a script element is created via `document.createElement('script')` and then inserted into the DOM (via `appendChild`, `replaceChild`, etc.), the browser treats it as a new script and executes it. This is different from scripts that appear in HTML set via `innerHTML`, which are parsed but not executed.

## Static Asset Handling Summary

The following static assets are now handled:

| Asset Type | Path Pattern | Handling |
|------------|--------------|----------|
| Main CSS | `/-/static/app.css` | Fetched once at startup, injected into `<head>` |
| Additional CSS | `/-/static/*.css` | Fetched per-request, inlined as `<style>` tags |
| External JS | `/-/static/*.js` | Fetched per-request, inlined as `<script>` tags |

## Testing Notes

Due to network restrictions in the test environment (Playwright browser couldn't access CDN for Pyodide), full integration testing wasn't possible. The fixes were developed and verified through:

1. Manual code analysis of Datasette's HTML output
2. Regex pattern testing with Python
3. Logic verification of the script execution mechanism

To fully test these changes, run datasette-lite in a browser with network access and verify:
1. CSS styles are properly applied (header should have gradient background)
2. SQL editor has CodeMirror syntax highlighting
3. Dropdown menus and other JavaScript functionality works

## Future Improvements

1. **Caching**: Cache fetched static assets in the worker to avoid re-fetching on every page load.

2. **Service Worker**: For a more elegant solution, implement a Service Worker that intercepts `/-/static/*` requests and forwards them to the Pyodide Datasette instance.

3. **Error Handling**: Add better error handling and fallbacks when static assets can't be fetched.

4. **Plugin Support**: Plugins may include their own static assets - the current solution handles `/-/static/` but plugins might use different paths.
