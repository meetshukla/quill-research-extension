# Quill Research Extension

Standalone Chrome Manifest V3 extension for researching X posts, saving reply
candidates locally, and drafting replies for human review. Version **0.6.13**.

This is the local-first Jev/Gemini extension, not the backend-connected companion
in [`meetshukla/quill`](https://github.com/meetshukla/quill/tree/main/extension).
No backend deployment or build step is required.

## Install for development

1. Clone this repository.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this repository's root directory and open X.
4. Open **Quill for X** from Chrome's toolbar.
5. In Settings, enter your own Google Gemini key for drafting and Vercel AI
   Gateway key for Jev relevance. Review the privacy settings and test Jev.
6. Import your own `profile.md` and `opinions.md` through Settings to personalize
   replies. Bundled voice files are generic templates, not the author's examples.

**Existing users:** keep using your existing unpacked extension directory and
reload its existing Chrome entry when updating. Do not uninstall/re-add or point
Chrome at another folder if you need to preserve its current identity and local
storage. Saved tweets, drafts, keys and imported voices live in the browser, not
in Git. Publishing this repository does not migrate them.

## Behavior

- **Analyze loaded posts** snapshots all identifiable posts currently present in
  the page, including off-screen posts. It evaluates that fixed batch, applies
  results together, and stops. It does not auto-scroll or retrieve posts X has
  already removed from the page.
- Scrolling, page changes and Hide/Show never start more evaluations.
- **Analyze & save loaded posts** also saves selected candidates to Replies.
- Hide/Show is reversible and never deletes a saved post.
- Jev uses Vercel AI Gateway; Gemini calls Google directly. No shared key is
  bundled. Request pacing is shared across tabs in the same Chrome profile.
- Replies are drafts only. The extension never auto-publishes or schedules.

See [JEV.md](JEV.md) for scoring, limits, privacy, and verification details.

## Code map

| Files | Responsibility |
| --- | --- |
| `background.js` | Trusted extension message routing |
| `jev.js` | Jev transport, cache, settings, usage and request pacing |
| `relevance.js` | Fixed-batch lifecycle and reversible post controls |
| `content.js`, `content.css` | X extraction, capture and inline actions |
| `sidebar.*`, `jev-panel.js` | Sidebar workflows and settings |
| `gemini.js`, `reply-quality.js`, `voice/` | Direct Google drafting and voice inputs |
| `candidates.js` | Local saved-tweet/draft storage; preserve its schema |
| `tests/` | Worker and isolated browser regression tests |

## Tests

Use Node.js 22 or newer. Worker tests need no dependencies:

```sh
node --test tests/jev.test.cjs
```

For the complete suite:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node --test tests/jev.test.cjs tests/browser.test.cjs
```

Browser tests use a temporary profile and intercept all requests. They do not
need real X, Gateway or Gemini credentials. `QUILL_BROWSER` can point to an
installed Chrome executable and `QUILL_PLAYWRIGHT` to an existing Playwright
package. The published snapshot was verified with Playwright 1.62.1.

After changing code, reload the extension in `chrome://extensions`, reload X,
and reopen the side panel. Do not commit browser profiles, exports, keys, personal
voice examples, or real saved tweets. Keep Jev routing separate from Gemini and
preserve the explicit-click-only analysis contract.
