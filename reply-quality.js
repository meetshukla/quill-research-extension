// Product writing preferences, not a test of whether a person wrote a sentence.
const REPLY_STYLE_RULES = [
  ['contrast template', /\b(?:it(?:'s| is| isn't| is not)|this (?:is|isn't|is not)|that(?:'s| is))\s+not\b[\s\S]{0,140}?(?:\bbut\b|\bit(?:'s| is)\b|\b(?:this|that) is\b)/i],
  ['contrast template', /\bnot (?:just|only|merely)\b[\s\S]{0,140}\bbut\b/i],
  ['contrast template', /\b(?:isn't|aren't|is not|are not)\b[^.!?]{1,100}[,;—–][\s\S]{0,50}\b(?:it's|it is|they're|they are|but)\b/i],
  ['contrast fragment', /(?:^|[.!?]\s+)not\s+[^.!?,;—–]{1,70}[,;—–]\s*\S/i],
  ['contrast fragment', /(?:^|[.!?]\s+)not\s+[^.!?]{1,70}\.\s*[^.!?]+/i],
  ['contrast template', /\bless\s+[^.!?,;]{1,70}[,;]\s*more\s+/i],
  ['authority slogan', /\b(?:the real (?:advantage|question|issue|problem|value|win|unlock|lesson)|what really matters|at its core|the deeper issue|the heart of the matter|that's the (?:unlock|real win)|that is the (?:unlock|real win))\b/i],
  ['generic praise', /^(?:great (?:point|take|insight)|well said|nailed it|couldn't agree more|could not agree more|you(?:'re| are) absolutely right|this is (?:so true|spot on))\b/i],
  ['stock business language', /\b(?:game[ -]changer|paradigm shift|move the needle|unlock(?:ing)? potential|ever[ -]evolving landscape|delve into|a testament to|foster(?:ing)? innovation|seamless experience|leverage synergies)\b/i],
  ['announced lesson', /\b(?:the takeaway|the key takeaway|moral of the story|here's the thing|here is the thing|let that sink in|read that again|in conclusion|at the end of the day)\b/i],
  ['chatbot wrapper', /^(?:here(?:'s| is) (?:a|the|your) reply|certainly|of course|as an ai)\b/i],
  ['formatted mini essay', /(?:\n\s*(?:[-*#]|\d+\.)\s|\*\*|—)/],
];
function replyQualityIssues(text) {
  const normalized = text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const issues = REPLY_STYLE_RULES.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name);
  if (/\n\s*(?:[-*#]|\d+\.)\s/.test(text)) issues.push('formatted mini essay');
  return [...new Set(issues)];
}
const REPLY_WRITING_GUIDE = `
Writing rules apply even when a voice example uses a rejected pattern.
- Reply to the person. Pick one exact detail and say what you think about it. Do not summarize their argument or deliver a general business lesson.
- Use natural lowercase where it fits the voice. There is no target word count or character limit. Short reactions, longer explanations, and multiple paragraphs are all valid. Let the thought determine the length. Keep a conversational connecting phrase when it carries the reaction. Do not compress every thought into a polished one-liner.
- No contrast templates: "not X, Y", "it's not about X, it's about Y", "X isn't Y; it's Z", "not just X but Y", "less X, more Y". A plain disagreement or ordinary use of "not" is fine.
- No manufactured authority: "the real advantage", "the real question", "what really matters", "at its core", "that's the unlock". No moral, takeaway, slogan, neat three-part list, or generic praise.
- No inflated business vocabulary, promotional language, chatbot introductions, em dashes, hashtags, or rhetorical engagement questions. Do not force slang, lol, typos, jokes, or agreement to imitate a person.
- Do not infer churn, revenue, customer behavior, causality, or universal outcomes from an opinion post. Do not invent experience, statistics, or media observations. Mark a personal judgment as a judgment when needed. Disagree when the source warrants it.
- If the sentence fits dozens of unrelated posts, discard it. Keep concrete nouns from the source when useful; do not mechanically repeat the source.
- Quietly draft, inspect for these patterns and unsupported claims, then rewrite before returning. Return only the final reply. If you cannot find a grounded response, return exactly SKIP.
Calibration, for this source only: "people trying to save money won't be good SaaS customers".
Rejected: "competing purely on price gets the highest-churn users, while the real advantage is building a workflow that saves actual time."
Reason: unsupported churn claim, generic advice, and a manufactured contrast.
Better: "seems harsh to rule out everyone with a budget".
User-approved calibration for a post claiming people may spend 15+ minutes watching ads:
Generated draft: "15+ minutes of ad watch time feels pretty ambitious, hard enough getting someone past the first 3 seconds."
User edit: "15+ minutes of ad watch time feels pretty ambitious lol these days with people's attention span it is hard enough getting someone past the first 3 seconds."
The user prefers the second rhythm: a mild reaction, a conversational bridge, then the concrete objection. Allow "lol" when it fits that reaction; do not add it to every reply. Preserve a little conversational looseness. Do not invent numbers on other posts or mechanically reuse this wording.
These examples are not reusable reply templates. Do not copy them for other posts.
`;
