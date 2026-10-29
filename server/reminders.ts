import { needsNextMoves } from "../shared/next-moves";
import { isDeliveryStatus, type Board } from "../shared/model";

/** Agent-facing, English (NEXT-MOVES-SPEC §9.6). Text only: the write they ride on has already succeeded. */
export const movesReminder =
  "No next moves suggested this turn. Before you end the turn, call flowly_suggest_next_moves with the 1-3 messages the user is most likely to send you next (recommended first), or with moves=[] if nothing needs the user. This write already succeeded.";
export const answersReminder =
  "No answers suggested for your question. If the user is likely to reply with one of a few options, call flowly_suggest_next_moves with those replies (1-3, recommended first) before you end the turn, or with moves=[] if the reply is free-form. This write already succeeded.";
export const ideasReminder =
  "You have proposed no ideas on this card. Consider 0-3 ideas (flowly_propose_idea) for worthwhile follow-ups you noticed: bugs, refactors, next features. Zero is fine; decide on purpose.";
export const outputsReminder =
  "This delivery omitted outputs. Before you end the turn, register its deliverables (especially PR/MR links, reports and evidence) with flowly_add_artifact role=output. On deliveries (status=in_review, status=committed or kind=result), pass outputs=[{target,title,note}], or outputs=[] when there are none. This write already succeeded; do not repeat it just to add outputs.";

/** The write a reminder can ride on: a status change or a progress report, as the agent sent it. */
export type DeliveryCall = { action: "status"; status: string } | { action: "progress"; kind: string };

/**
 * Reminders for a delivery, ask or result that succeeded (NEXT-MOVES-SPEC §9.2-9.3, IDEAS-SPEC §4.1), read from the
 * board as it is after the write, so next moves the call itself carried count. Never throws and never blocks.
 */
export function deliveryReminders(
  board: Pick<Board, "events" | "ideas">,
  who: { taskId: string; agentId: string },
  call: DeliveryCall,
  ideasOn: boolean,
): string[] {
  const asks = call.action === "progress" && call.kind === "question";
  const delivers = call.action === "status" && isDeliveryStatus(call.status);
  const wraps = delivers || (call.action === "status" && call.status === "blocked") || asks || (call.action === "progress" && call.kind === "result");
  if (!wraps) return [];
  const out: string[] = [];
  if (needsNextMoves(board.events, who.taskId, who.agentId)) out.push(asks ? answersReminder : movesReminder);
  // Card-level, from the ideas themselves: the card's events keep only the latest 100.
  if (delivers && ideasOn && !board.ideas.some((i) => i.taskId === who.taskId && i.agentId === who.agentId)) out.push(ideasReminder);
  return out;
}
