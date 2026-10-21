"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import {
  fetchPoolRecoveryContext,
  fetchPoolRecoveryOperation,
  recoverPoolRun,
} from "@/lib/api/domains/task-pool-recovery-api";
import { poolRecoveryCommand, matchesPoolRecoveryResult } from "@/lib/task-pool-recovery";
import {
  readPendingPoolRecovery,
  savePendingPoolRecovery,
  forgetPendingPoolRecovery,
} from "@/lib/task-pool-recovery-pending";
import { generateUUID } from "@/lib/uuid";
import type { PoolRecoveryAction, PoolRecoveryCommand } from "@/lib/types/task-pool-recovery";
import { usePoolRead } from "./use-task-pool";

export type PoolRecoveryInput = {
  taskId: string;
  runId: string;
  scope: string;
  authenticated: boolean;
  fresh: boolean;
  executionVersion?: string;
  onCommitted: () => void;
};

type Status =
  | "idle"
  | "sending"
  | "querying"
  | "submitted"
  | "unknown"
  | "rejected"
  | "changed"
  | "unavailable";
type ActionState = {
  scope: string;
  status: Status;
  proposal: PoolRecoveryCommand | null;
  pending: PoolRecoveryCommand | null;
  completed?: PoolRecoveryCommand;
};

function initialAction(scope: string, journalScope: string, runId: string): ActionState {
  const base = { scope, proposal: null, pending: null };
  try {
    const pending = readPendingPoolRecovery(journalScope, runId);
    return { ...base, pending, status: pending ? "unknown" : "idle" };
  } catch {
    return { ...base, status: "unavailable" };
  }
}

function useRecoveryRead(input: PoolRecoveryInput, scope: string) {
  return usePoolRead(
    input.runId ? scope : "",
    async (signal) => {
      const data = await fetchPoolRecoveryContext(input.taskId, input.runId, { init: { signal } });
      if (!data || data.task_id !== input.taskId || data.run_id !== input.runId)
        throw new Error("pool_recovery_context_changed");
      return data;
    },
    input.executionVersion,
  );
}

type RecoveryRead = ReturnType<typeof useRecoveryRead>;
type RecoveryOwner = {
  input: PoolRecoveryInput;
  scope: string;
  read: RecoveryRead;
  action: ActionState;
};

function sameProposal(owner: RecoveryOwner, command: PoolRecoveryCommand) {
  return (
    JSON.stringify(proposalFor(owner, command.action, command.operation_id)) ===
    JSON.stringify(command)
  );
}

function retainOperation(owner: RecoveryOwner, command: PoolRecoveryCommand) {
  try {
    savePendingPoolRecovery(owner.input.scope, command);
    return true;
  } catch {
    return false;
  }
}

function forgetOperation(owner: RecoveryOwner, command: PoolRecoveryCommand) {
  try {
    forgetPendingPoolRecovery(owner.input.scope, command.operation_id);
  } catch {
    /* 原生回执不因本地清理失败失效；重新打开仍只查询。 */
  }
}

function definiteRejection(error: unknown) {
  return error instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(error.status);
}

async function dispatchRecovery(
  owner: RecoveryOwner,
  command: PoolRecoveryCommand,
  query: boolean,
): Promise<Status> {
  try {
    const receipt = query
      ? await fetchPoolRecoveryOperation(owner.input.taskId, command.run_id, command.operation_id)
      : await recoverPoolRun(owner.input.taskId, command);
    return matchesPoolRecoveryResult(receipt, owner.input.taskId, command)
      ? "submitted"
      : "unknown";
  } catch (error) {
    return !query && definiteRejection(error) ? "rejected" : "unknown";
  }
}

function proposalFor(owner: RecoveryOwner, action: PoolRecoveryAction, operationId: string) {
  const { input, read } = owner;
  if (
    !input.authenticated ||
    !input.fresh ||
    read.loading ||
    read.error ||
    !read.data ||
    !read.confirmedAt ||
    Date.now() - read.confirmedAt >= 30_000 ||
    document.visibilityState !== "visible"
  )
    return null;
  return poolRecoveryCommand(read.data, action, operationId);
}

function settledAction(
  owner: RecoveryOwner,
  command: PoolRecoveryCommand,
  status: Status,
): ActionState {
  return {
    scope: owner.scope,
    proposal: null,
    pending: status === "unknown" ? command : null,
    completed: status === "submitted" ? command : undefined,
    status,
  };
}

function useRecoveryTransport(
  current: React.RefObject<RecoveryOwner>,
  update: (next: ActionState) => void,
  mounted: React.RefObject<boolean>,
) {
  const busy = useRef(false);
  const callbackScope = current.current.scope;
  const request = async (query: boolean) => {
    const owner = current.current;
    const command = query ? owner.action.pending : owner.action.proposal;
    if (busy.current || !command || !owner.input.authenticated || owner.scope !== callbackScope)
      return;
    const isCurrent = () => mounted.current && current.current.scope === owner.scope;
    if (!query && !sameProposal(owner, command)) {
      update({ ...owner.action, proposal: null, status: "changed" });
      return;
    }
    if (!query && !retainOperation(owner, command)) {
      update({ ...owner.action, proposal: null, status: "unavailable" });
      return;
    }
    busy.current = true;
    update({
      ...owner.action,
      proposal: null,
      pending: command,
      status: query ? "querying" : "sending",
    });
    const status = await dispatchRecovery(owner, command, query);
    busy.current = false;
    if (status !== "unknown") forgetOperation(owner, command);
    if (!isCurrent()) return;
    update(settledAction(owner, command, status));
    if (status === "submitted") current.current.input.onCommitted();
    void current.current.read.refresh();
  };
  return { busy, confirm: () => request(false), query: () => request(true) };
}

export function useTaskPoolRecovery(input: PoolRecoveryInput) {
  const generation = useRef({ base: input.scope, value: 0 });
  if (generation.current.base !== input.scope)
    generation.current = { base: input.scope, value: generation.current.value + 1 };
  const scope = `${input.scope}:${generation.current.value}`;
  const initial = useMemo(
    () => initialAction(scope, input.scope, input.runId),
    [scope, input.scope, input.runId],
  );
  const [action, setAction] = useState(initial);
  const read = useRecoveryRead(input, scope);
  const visible = action.scope === scope ? action : initial;
  const current = useRef({ input, scope, read, action: visible });
  current.current = { input, scope, read, action: visible };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (next: ActionState) => {
    current.current.action = next;
    setAction(next);
  };
  const transport = useRecoveryTransport(current, update, mounted);
  const canPrepare = (next: PoolRecoveryAction) =>
    !transport.busy.current &&
    !["unknown", "sending", "querying", "unavailable"].includes(current.current.action.status) &&
    (!current.current.action.completed ||
      current.current.read.data?.run_version !==
        current.current.action.completed.expected_run_version) &&
    !!proposalFor(current.current, next, "ffffffff-ffff-4fff-8fff-ffffffffffff");
  const prepare = (next: PoolRecoveryAction) => {
    if (!canPrepare(next)) return false;
    const proposal = proposalFor(current.current, next, generateUUID());
    if (!proposal) return false;
    update({ scope, proposal, pending: null, status: "idle" });
    return true;
  };
  const cancel = () => {
    if (!transport.busy.current) update({ ...current.current.action, proposal: null });
  };
  const proposal = visible.proposal;
  return {
    read,
    proposal,
    status: visible.status,
    completedAction: visible.completed?.action,
    canPrepare,
    prepare,
    cancel,
    confirm: transport.confirm,
    query: transport.query,
    confirmationKey: proposal
      ? JSON.stringify(proposalFor(current.current, proposal.action, proposal.operation_id))
      : "none",
  };
}
