# Jev in Quill 0.6.13 — one click, one fixed batch

## What changed

Quill now uses meaning, not keyword rules. MATCH, EXCLUDE, and PRIORITY lists are inactive: they neither select, exclude, highlight, sort, nor hide posts. Their saved values remain available in the Legacy tab, so the update does not delete your configuration. Jev failures do not fall back to keywords.

There are three separate actions:

1. **Analyze loaded posts:** freeze all identifiable posts currently mounted in the page, including above and below the viewport, evaluate that batch, apply results together, then stop automatically. This does not auto-scroll or retrieve posts X has already removed from the page.
2. **Analyze & save loaded posts:** the same finite batch, also saving relevant and uncertain posts to Replies.
3. **Reply:** Gemini drafts a reply when you ask; you review and publish it yourself.

Opening X, scrolling, DOM updates, enabling Jev, changing Hide, changing interests, and testing a connection never start feed analysis. Rendering cannot enqueue requests. A batch owns a frozen, URL-deduplicated snapshot of all loaded sources, without a viewport filter or silent 100-post cutoff. Newly appearing posts require another click. Cancel drops pending work, cancels retry timers and rejects late results; completed scores remain available. Five minutes without a successful evaluation stops a stalled batch; successful progress renews that deadline so larger batches can finish at the allowed request rate. Profile/article export is separate from feed evaluation.

## Your interests, expressed as meaning

The default brief covers AI advertising and ad creatives; e-commerce and DTC; AI video/animation generators and apps; app marketing and user acquisition; creative testing and performance marketing; UGC and AI UGC; reaction videos; talking-head, avatar, lip-sync, and informal talking/yapping videos.

It explicitly includes launches, demos, tools, creator and merchant workflows, problems and results—not only posts phrased as questions. A merchant discussing why creator-led product clips sell should count even without literally saying “AI ads” or “UGC.” Generic AI/programming/startup news without a meaningful connection is not enough.

This is a natural-language instruction to Jev, not a string-matching list. Actual quality still needs evaluation on real examples.

The previous exact generic default is upgraded to this brief. If you already wrote a custom brief, it is preserved. **Use my AI creative / e-commerce focus** loads the new preset into the editor; review it and Save to apply.

## How a post is judged

Quill extracts the exposed post text and canonical URL, plus flags for media, linked articles and truncation. One Jev request asks three independent Boolean questions:

- Is the topic relevant to the reader's work?
- Is there a useful opening for a reply?
- Is important context missing?

Reply opportunity is supplementary information; a low opportunity score cannot exclude a relevant post. Saved-queue ordering uses topic relevance alone.

| Chip | Starting rule | Automatic view behavior |
| --- | --- | --- |
| Small green N% | Relevance ≥ 65%, missing context < 35% | Visible |
| Small gray N% | Relevance < 25%, missing context < 35% | Collapsed only when Hide is enabled |
| Small amber N%, with ? for missing context | Everything else | Visible |
| No score chip | No usable current evaluation | Visible; shared status is in the sidebar |

Percentages are model estimates, not calibrated accuracy, predicted engagement or verified facts. Truncated/text-empty sources always receive a missing-context guard. Jev does **not** watch the video, listen to audio, view an image, or open an article. A text-only judgment is insufficient for some video-heavy posts; inspect those manually.

## Collapse and restore

In Capture → **Your feed · relevance view**:

- **Analyze loaded posts** evaluates the fixed loaded-post snapshot. The sidebar shows checked/total, any rate-limit wait, then Done. It returns to its idle button automatically.
- **Hide posts unrelated to my work** only filters already checked posts, collapsing clearly low-relevance posts into one small chip-and-Show row. It never starts requests.
- Every identifiable post has a **Hide / Show** button on the main X page. Manual Show keeps that post expanded through subsequent scrolling in the same page session.
- Turning off Hide or disabling Jev restores posts. Stopping requests keeps existing scores/filtering available. Manual visibility overrides are page-session-only and reset when the interests brief changes.
- Collapse styles use a Quill-owned data attribute, not X's React-managed className (which X can overwrite during live updates). It hides the original article's contents without deleting, cloning, replacing or rebuilding the tweet; Show restores its existing controls.
- X recycling an article for a different post clears the old visibility decision. Changed text/context invalidates the old chip.

Unknown posts are never automatically hidden. A manual Hide is your explicit override, regardless of the score.

Expanded controls sit next to the existing + List / Reply buttons in X's native action row, at 20px high. They are never inserted beside the tweet body at the article root. Only a collapsed post gets a full-width, 24px placeholder row (plus 6px padding above/below). Tooltips explain valid scores without filling the feed with status text.

## Activate without losing saved tweets

1. Keep using the existing unpacked folder named `quill-research-extension-0.6.5`; its manifest is now 0.6.13.
2. Stop collection and export any temporary profile/article capture you need.
3. Reload the **existing** Quill entry in `chrome://extensions`, then reload X and reopen the side panel. Do not uninstall/remove and re-add the extension.
4. In Settings → Jev, add your personal Vercel AI Gateway key, review/load the focused brief, enable Jev and Save. **Test connection** makes one real, metered request using a fixed sample; it does not send or change saved tweets. A saved key is not reported as a verified connection.
5. In Capture, click Analyze loaded posts. Optionally enable Hide unrelated posts. Wait for Done; Cancel batch discards pending work. Reloading starts idle. A successful connection test does not start analysis.
6. Use Analyze & save loaded posts if you also want candidates saved to Replies, or + List to save a post manually.

Existing saved tweets, drafts and recovery markers stay in `replyCandidatesV1`. That store's writer and format are unchanged. Assessments use a separate bounded `jevAssessmentsV1` cache. No saved post is removed merely for a low score or a collapse action.

## Routes, privacy, and usage

Jev alone uses `POST https://ai-gateway.vercel.sh/v1/evaluate`, model `typesafe-ai/jev`, restricted to the TypeSafe provider. The Gateway skill informed this separate evaluation route. Gemini's existing direct Google route, key, and voice files remain unchanged.

Settings exposes **Require Zero Data Retention**. It defaults on to preserve the previous privacy requirement. Vercel rejects that option on Hobby (the live response requires Pro/Enterprise); the user must explicitly turn it off to use standard Gateway data handling on Hobby. Errors never silently remove this flag, switch provider/model, or change billing. A valid card on the Gateway account is also required by the live service.

Jev receives exposed text, URL, context flags, and your interests brief—not your drafts or voice files. Its key stays in trusted extension-local storage; content scripts get only safe view flags and an opaque brief revision, never keys. Someone with access to the browser profile may still retrieve local secrets: use your own dedicated key, never distribute a shared key, and set a Vercel budget.

The worker serializes requests and persists request timestamps/cooldowns in `jevRateV1`: at least 2.5 seconds between starts and at most 24 attempts per rolling minute across this browser profile's Quill tabs, including probes and saved-post ranking. HTTP 429 respects Retry-After with a minimum 60-second cooldown. Waiting consumes no extra daily attempt. The content script retries only its existing finite batch; Cancel cancels the timer. Other machines or applications can still consume the team's shared allowance, so 429 remains possible and is handled explicitly. Network, other HTTP, invalid-response and daily-cap failures pause fresh evaluations in `jevHealthV1`. A successful explicit connection test clears that pause but never starts analysis. Keys and provider diagnostics are not exposed on tweets. No model/provider fallback is used; Gemini is unaffected.

The per-tab feed queue is bounded by the snapshot captured at the click; it cannot grow from scrolling or DOM changes. Default daily limit: 200 attempted requests per UTC day, editable from 1 to 1,000. Probes count against the same limit and cannot bypass it. Cached identical evaluations do not consume another request. Changing source text, context flags, brief, model or rubric invalidates the cache; changing a draft does not.

On errors, full queues or exhausted limits, posts without usable scores stay visible, with no placeholder score. They are not automatically keyword-selected. Existing valid assessments can remain in view. Stopping collection drops queued collection work; a sent request may still be billed but cannot save a post after the stop guard. Turning view/settings off discards outdated in-flight judgments.

## Verification

- 0.6.13: all 40 regression tests passed, including all 120 loaded posts completing without truncation and URL-deduplicated posts above/below the viewport. Native Chrome verified the updated Analyze loaded posts button and a real batch completing automatically at `Done · 6 / 6 checked`. The three saved replies remained present.
- `node --test tests/jev.test.cjs`: worker, transport and storage regression tests.
- `node --test tests/browser.test.cjs`: isolated Playwright with all requests intercepted and fake posts/model responses. Set `QUILL_PLAYWRIGHT` to the installed package path and optionally `QUILL_BROWSER` to a browser executable.
- Browser cases use a nested horizontal-flex tweet fixture, with 375px/600px geometry checks. They cover chips without collection, Show/Hide restoring the original DOM, uncertain/error visibility, pause/retry, keyword independence, queue bounds, stopping, dynamic insertion, recycled articles, brief invalidation and disabling during a request.
- Automated tests do not establish live Jev accuracy. On 2026-09-19, computer use verified the existing extension ID `epndagcibedagfpdkjdjbhanmclkagaf`, in-place update to 0.6.12, three retained saved replies, and a successful real connection test after the user approved standard Gateway data handling. No saved tweets/drafts were deleted and no reply was published.
- Final native Chrome check: a real three-post batch returned `Done · 3 / 3 checked` automatically. Manual Hide/Show restored the original post after the attribute fix. Scrolling to seven different loaded posts left the batch at 3/3 and showed no new score chips. Gemini and candidate-store writer files compare byte-for-byte with the pre-change backup.

Start by reviewing 30–50 representative posts, including ambiguous video posts and a sample marked low-relevance. Adjust the brief based on the false positives and missed topics before relying heavily on automatic collapsing.

## References

- [Jev introduction](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [Vercel evaluation API](https://vercel.com/docs/ai-gateway/modalities/evaluation)
