import type { Task } from '@/lib/types';

/**
 * Contracts between the session runtime (sessions.ts) and the flows.
 *
 * The runtime knows NOTHING about flows: it launches a prompt, streams events,
 * and reports how the session ended as a neutral SessionOutcome. Each flow
 * (implementation, conflict) supplies an OutcomeMapper that turns that outcome
 * into the task's terminal status + result log line.
 */

/** Neutral end-of-session report from the runtime — no flow semantics. */
export interface SessionOutcome {
  success: boolean;
  /** Failure detail, set when success is false. */
  errorText?: string;
  /** Last PR URL/number seen anywhere in the session's output, if any. */
  prUrl?: string;
  prNumber?: number;
}

/** A flow's verdict on a finished session: task patch + the result log line. */
export interface OutcomeMapping {
  patch: Partial<Task>;
  logKind: 'result' | 'error';
  logText: string;
}

export type OutcomeMapper = (outcome: SessionOutcome) => OutcomeMapping;
