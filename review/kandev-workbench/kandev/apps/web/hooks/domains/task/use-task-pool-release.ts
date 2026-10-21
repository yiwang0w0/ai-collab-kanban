"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchTask, moveTask, type MoveTaskPayload } from "@/lib/api/domains/kanban-api";
import { listWorkflowSteps } from "@/lib/api/domains/workflow-api";
import { poolReleaseMove, poolReleaseTargets } from "@/lib/task-pool-release";
import type { PoolCard } from "@/lib/types/task-pool";
import { usePoolRead } from "./use-task-pool";

export type PoolReleaseInput = {
  card: PoolCard;
  workspaceId: string;
  authenticated: boolean;
  fresh: boolean;
  onCommitted: () => void;
};

type Proposal = { key: string; stepName: string; profileId: string; payload: MoveTaskPayload };
type Action = {
  scope: string;
  proposal: Proposal | null;
  status: "idle" | "sending" | "submitted" | "unknown" | "rejected" | "changed";
};

function useReleaseRead(input: PoolReleaseInput, scope: string) {
  return usePoolRead(scope, async (signal) => {
    const options = { cache: "no-store" as const, init: { signal } };
    const [task, response] = await Promise.all([
      fetchTask(input.card.task_id, options),
      listWorkflowSteps(input.card.workflow_id, options),
    ]);
    if (
      task.id !== input.card.task_id ||
      task.workspace_id !== input.workspaceId ||
      task.workflow_id !== input.card.workflow_id ||
      task.workflow_step_id !== input.card.workflow_step_id
    )
      throw new Error("pool_release_context_changed");
    return { task, steps: response.steps };
  });
}

type ReleaseContext = {
  input: PoolReleaseInput;
  scope: string;
  read: ReturnType<typeof useReleaseRead>;
};

function releaseProposal(context: ReleaseContext, stepId: string): Proposal | null {
  const snapshot = context.read;
  if (
    !context.input.fresh ||
    snapshot.error ||
    !snapshot.data ||
    !snapshot.confirmedAt ||
    Date.now() - snapshot.confirmedAt >= 30_000 ||
    document.visibilityState !== "visible"
  )
    return null;
  const step = snapshot.data.steps.find((item) => item.id === stepId);
  if (!step) return null;
  const payload = poolReleaseMove(
    context.input.card,
    snapshot.data.task,
    step,
    context.input.authenticated,
  );
  if (!payload) return null;
  return {
    key: JSON.stringify([context.scope, payload]),
    stepName: step.name,
    profileId: step.agent_profile_id!,
    payload,
  };
}

export function useTaskPoolRelease(input: PoolReleaseInput) {
  const base = `${input.workspaceId}:${input.card.task_id}:${input.card.workflow_id}:${input.card.workflow_step_id}`;
  const generation = useRef({ base, version: 0 });
  if (generation.current.base !== base)
    generation.current = { base, version: generation.current.version + 1 };
  const scope = `${base}:${generation.current.version}`;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = useReleaseRead(input, scope);
  const [action, setAction] = useState<Action>({ scope, proposal: null, status: "idle" });
  const actionRef = useRef(action);
  const busy = useRef(false);
  const current = useRef({ input, scope, read });
  current.current = { input, scope, read };
  const update = (next: Action) => {
    actionRef.current = next;
    setAction(next);
  };
  const proposalFor = (stepId: string) => releaseProposal(current.current, stepId);
  const canPrepare = (stepId: string) => {
    const previous = actionRef.current;
    if (
      busy.current ||
      (previous.scope === scope && ["unknown", "submitted", "sending"].includes(previous.status))
    )
      return false;
    return !!proposalFor(stepId);
  };
  const prepare = (stepId: string) => {
    if (!canPrepare(stepId)) return false;
    const proposal = proposalFor(stepId);
    if (!proposal) return false;
    update({ scope, proposal, status: "idle" });
    return true;
  };
  const cancel = () => {
    if (actionRef.current.scope === scope && !busy.current)
      update({ ...actionRef.current, proposal: null });
  };
  const confirm = async () => {
    const pending = actionRef.current;
    if (busy.current || pending.scope !== current.current.scope || !pending.proposal) return;
    const isCurrent = () => mounted.current && current.current.scope === scope;
    const expected = proposalFor(pending.proposal.payload.workflow_step_id);
    if (expected?.key !== pending.proposal.key) {
      update({ scope, proposal: null, status: "changed" });
      return;
    }
    busy.current = true;
    update({ scope, proposal: null, status: "sending" });
    let committed = false;
    try {
      await moveTask(input.card.task_id, pending.proposal.payload);
      committed = true;
    } catch (error) {
      if (isCurrent())
        update({
          scope,
          proposal: null,
          status: error instanceof ApiError && error.status < 500 ? "rejected" : "unknown",
        });
    } finally {
      busy.current = false;
    }
    if (!isCurrent()) return;
    if (committed) {
      update({ scope, proposal: null, status: "submitted" });
      current.current.input.onCommitted();
    }
    void current.current.read.refresh();
  };
  const visible =
    action.scope === scope ? action : { scope, proposal: null, status: "idle" as const };
  return {
    read,
    targets: read.data && !read.error ? poolReleaseTargets(read.data.task, read.data.steps) : [],
    proposal: visible.proposal,
    status: visible.status,
    canPrepare,
    prepare,
    cancel,
    confirm,
    confirmationKey: visible.proposal
      ? (proposalFor(visible.proposal.payload.workflow_step_id)?.key ?? "unavailable")
      : "none",
  };
}
