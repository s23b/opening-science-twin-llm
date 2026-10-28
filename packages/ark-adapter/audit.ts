import "server-only";

import { append } from "@/packages/audit/append";
import { database } from "@/infrastructure/database";

import { arkAuditOverride } from "./hooks";

/**
 * Hashes inventory metadata and content-free app summaries. Export callers
 * pass counts only, including on failure. row_count is always 0 here.
 */

export type ArkAuditContext = {
  readonly actor: string;
  readonly sessionId: string;
  readonly subjectRef?: string | null;
};

export type ArkAuditTool =
  | "ark.status"
  | "ark.doctor"
  | "ark.data.list"
  | "ark.data.paths"
  | "ark.app.run"
  | "ark.export";

export const auditArkCall = async (
  ctx: ArkAuditContext,
  tool: ArkAuditTool,
  args: unknown,
  result: unknown,
): Promise<void> => {
  const override = arkAuditOverride();
  if (override) {
    await override(ctx, tool, args, result);
    return;
  }
  await append(database(), {
    actor: ctx.actor,
    sessionId: ctx.sessionId,
    subjectRef: ctx.subjectRef ?? null,
    tool,
    args,
    result,
    rowCount: 0,
  });
};
