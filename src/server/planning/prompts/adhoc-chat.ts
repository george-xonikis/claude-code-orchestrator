/**
 * CASE: Ad-hoc planning chat — the pass-level chat on the Planning page.
 *
 * Two builders live here:
 * - `adHocChatPrompt` drives one cheap conversational turn. It shapes the
 *   direction for the NEXT ad-hoc pass; it never produces proposals itself
 *   (proposals only ever come from a regenerated pass). Its static wording is
 *   DEFAULT_ADHOC_CHAT_TEMPLATE (admin-overridable via Settings → Prompts).
 * - `adHocDirectionBlock` renders the agreed direction into the PE/PM and
 *   synthesis prompts — but ONLY for ad-hoc passes; scheduled/auto and plain
 *   manual passes always run without it.
 */

import { renderTemplate } from '@/server/core/render';
import type { DiscussionMessage } from '@/server/planning/prompts/discussion';

/** Render a transcript as DEVELOPER/YOU turns. */
function transcript(messages: DiscussionMessage[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'DEVELOPER' : 'YOU'}: ${m.text}`)
    .join('\n\n');
}

export const DEFAULT_ADHOC_CHAT_TEMPLATE = `You are helping a developer decide what the NEXT ad-hoc planning pass should
look for in their repository. Your job in this conversation is to sharpen the
direction — nothing else.

HARD RULES:
- Do NOT write proposals, task lists, or issue drafts. Proposals are produced
  only when the developer regenerates the pass; the Principal Engineer and
  Product Manager agents write them, not you.
- Do NOT scan or read the repository. This is a cheap conversational turn.
  Reason from the goal, the current proposals, and what the developer tells
  you. If a decision truly hinges on something only the code can answer, say
  so and let the pass find out.
- Ask a clarifying question when the direction is genuinely ambiguous, but at
  most one per reply, and only when the answer would change what gets planned.

BE BRIEF AND SCANNABLE. Aim for 2-5 short sentences. Lead with your read of
the direction, then the one thing you need from them. Prefer short bullets
over dense prose. Use a few tasteful emoji as anchors (✅ agreed, ⚠️ risk,
💡 suggestion, ❓ open question) — at most one per line. Backtick file and
symbol names. No preamble, no recap, no filler.

When the direction is clear enough to act on, say so plainly and tell them to
hit **Run ad-hoc pass** (the button under this chat — call it by that exact
name, never invent another) — do not restate the whole brief back to them.

## Project goal
{{goal}}

## Proposals currently on the board
{{currentProposals}}

{{#transcript}}
## Conversation so far
{{transcript}}
{{/transcript}}

Reply to the last developer message.`;

export function adHocChatPrompt(
  goal: string,
  currentProposals: string[],
  messages: DiscussionMessage[],
  template?: string
): string {
  return renderTemplate(template ?? DEFAULT_ADHOC_CHAT_TEMPLATE, {
    goal: goal.trim() || '(no goal file)',
    currentProposals:
      currentProposals.length > 0
        ? currentProposals.map((title) => `- ${title}`).join('\n')
        : '(none yet)',
    transcript: transcript(messages),
  });
}

/**
 * The developer's ad-hoc planning direction, injected into the PE/PM and
 * synthesis prompts of an ad-hoc pass. Returns '' when there is no
 * conversation to inject.
 */
export function adHocDirectionBlock(messages: DiscussionMessage[]): string {
  if (messages.length === 0) return '';
  return [
    "DEVELOPER'S DIRECTION FOR THIS PASS — this is the developer's ad-hoc",
    'planning direction, in their own words (with your earlier replies for',
    'context). It outranks your own sense of what is most valuable: propose what',
    'they are asking for, and skip areas they have directed you away from. Where',
    'it conflicts with the standing goal or topics, the direction below wins for',
    'this pass.',
    '',
    transcript(messages),
  ].join('\n');
}
