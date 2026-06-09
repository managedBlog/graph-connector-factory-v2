/**
 * Shared instruction truncation utility.
 *
 * Copilot Studio enforces an 8,000 character limit on agent instructions.
 * This module provides a single source of truth for that limit and truncation logic.
 */

import { log } from "../../logging/logger";

export const INSTRUCTION_CHAR_LIMIT = 8_000;

/**
 * Truncate instructions to fit within Copilot Studio's character limit.
 * Returns the original string if within bounds.
 */
export function truncateInstructions(instructions: string): string {
  if (instructions.length <= INSTRUCTION_CHAR_LIMIT) return instructions;

  log(`[Instructions] Truncating ${instructions.length} chars to ${INSTRUCTION_CHAR_LIMIT} limit`);
  return instructions.slice(0, INSTRUCTION_CHAR_LIMIT - 50) +
    "\n\n*(Instructions truncated due to length limit)*";
}
