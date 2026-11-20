# Guest template bundle format

One directory per template listed in `../catalog.js` `TEMPLATES`. The loader
(`index.js`) is generic: it knows the shape below and nothing about any
individual template, so adding a starter to the catalogue is a data change.

`variant.json`

```json
{
  "defaults": { "accent": "indigo", "extra": "none" },
  "knobs": {
    "accent": { "options": { "indigo": "#4f46e5", "emerald": "#059669" } },
    "extra":  { "options": { "none": null, "page": null, "footer": null } }
  },
  "derived": {
    "FOOTER":     { "footer": "<footer class=site-footer>Contact: hello@example.test</footer>" },
    "ABOUT_LINK": { "page":   "<a href=\"about.html\">About</a>" }
  }
}
```

`knobs.<name>.options` is the **allowlist**: a value that is not a key there is
rejected, so nothing a caller sends is ever interpolated into a page. `derived`
maps a placeholder name to a fixed string per knob value; the placeholder is
empty when the selection has no entry.

`deploy.json`

```json
{
  "label": "Hello world",
  "tokens": { "TITLE": "Hello world", "RUNTIME": "Static preview." },
  "files": [
    { "path": "index.html", "src": "index.html" },
    { "path": "styles.css", "src": "../_shared/styles.css" },
    { "path": "server.js",  "src": "server.js", "when": { "stack": ["node"] } },
    { "path": "about.html", "src": "about.html", "when": { "extra": ["page"] } }
  ]
}
```

`files[].when` is a knob-value condition, and every file is a real file in the
bundle. A `{{TOKEN}}` left in a shipped file after substitution is an error: it
means the copy references a knob or token the bundle no longer defines, which
would otherwise reach the visitor as literal braces.
