/**
 * All LLM-facing prompts, split one file per case. Edit the wording in the
 * per-case files; the server modules (sessions.ts, planning.ts) import from here
 * and only handle the machinery around each prompt.
 *
 * - implementation-session — the autonomous issue-working agent + its tools
 * - planning-agent         — the PE/PM persona pass wrapper
 * - planning-exclusions    — the "do NOT re-propose" digest
 * - planning-synthesis     — merge PE + PM reports into ranked JSON
 * - proposal-discussion    — the "Discuss with Claude Code" drawer + its tools
 */

export {
  buildPrompt,
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_QUESTION_DESCRIPTION,
  SAVE_MEMORY_TOOL_DESCRIPTION,
  SAVE_MEMORY_LESSON_DESCRIPTION,
} from './implementation-session';
export { planningAgentPrompt } from './planning-agent';
export { exclusionDigest } from './planning-exclusions';
export { synthesisPrompt } from './planning-synthesis';
export {
  discussionPrompt,
  UPDATE_PROPOSAL_TOOL_DESCRIPTION,
  CREATE_PROPOSAL_TOOL_DESCRIPTION,
  type DiscussionMessage,
} from './proposal-discussion';
