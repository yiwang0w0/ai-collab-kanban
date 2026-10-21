"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import TaskLink from "@/components/routing/task-link";
import { useTaskPoolHistory } from "@/hooks/domains/task/use-task-pool";
import { poolReasonGroup } from "@/lib/task-pool-view-model";
import type { PoolCard } from "@/lib/types/task-pool";
import { PoolAgent, PoolState, PoolTimeline, PoolTechnicalDetails } from "./task-pool-facts";
import { TaskPoolRelations } from "./task-pool-relations";
import { TaskPoolRelease } from "./task-pool-release";
import { TaskPoolRecovery } from "./task-pool-recovery";

export function TaskPoolDetail({
  card,
  children,
  workspaceId,
  fresh,
  onRefresh,
  onBack,
}: {
  card: PoolCard;
  children: PoolCard[];
  workspaceId: string;
  fresh: boolean;
  onRefresh: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const execution = card.pool_execution;
  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      data-testid="pool-detail"
    >
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-3">
          {onBack && (
            <Button variant="outline" onClick={onBack} data-testid="pool-back">
              {t("taskPool:back")}
            </Button>
          )}
          <h2 className="break-words text-lg font-semibold">{card.title}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {t("taskPool:stage")}: {card.stage}
            </span>
            <PoolState execution={execution} />
          </div>
          <p className="text-sm">
            {t("taskPool:actualAgent")}:{" "}
            <PoolAgent profileId={execution?.claimed_agent_profile_id} />
          </p>
          {execution?.planned_agent_profile_id && (
            <p className="text-xs text-muted-foreground">
              {t("taskPool:plannedAgent")}:{" "}
              <PoolAgent profileId={execution.planned_agent_profile_id} />
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {t(`taskPool:reasons.${poolReasonGroup(card.eligibility.reason)}`)}
          </p>
          <Button asChild className="max-w-full">
            <TaskLink taskId={card.task_id} sessionId={execution?.session_id || undefined}>
              {t("taskPool:nativeWorkbench")}
            </TaskLink>
          </Button>
        </header>
        {!execution && (
          <TaskPoolRelease
            card={card}
            workspaceId={workspaceId}
            fresh={fresh}
            onRefresh={onRefresh}
          />
        )}
        <section className="space-y-3" data-testid="pool-current-timeline">
          <h3 className="text-sm font-semibold">{t("taskPool:timeline")}</h3>
          <PoolTimeline execution={execution} />
        </section>
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          {t("taskPool:terminalNote")}
        </p>
        <TaskPoolRelations card={card} children={children} />
        <PoolHistory taskId={card.task_id} />
        <section className="space-y-2">
          {execution?.run_id && (
            <TaskPoolRecovery
              taskId={card.task_id}
              runId={execution.run_id}
              workspaceId={workspaceId}
              title={card.title}
              fresh={fresh}
              executionVersion={JSON.stringify(execution)}
              onRefresh={onRefresh}
            />
          )}
          <Button asChild variant="outline">
            <TaskLink taskId={card.task_id}>{t("taskPool:moveInWorkbench")}</TaskLink>
          </Button>
        </section>
        <PoolTechnicalDetails execution={execution} />
      </div>
    </div>
  );
}

function PoolHistory({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const [cursors, setCursors] = useState<string[]>([""]);
  const read = useTaskPoolHistory(taskId, cursors[cursors.length - 1]);
  return (
    <section className="space-y-3" data-testid="pool-history">
      <h3 className="text-sm font-semibold">{t("taskPool:history")}</h3>
      <p className="text-xs text-muted-foreground">{t("taskPool:historyPage")}</p>
      {read.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("taskPool:unavailable")}
        </p>
      ) : null}
      {read.loading && !read.data && <p role="status">{t("taskPool:loading")}</p>}
      {read.data?.items.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("taskPool:noHistory")}</p>
      )}
      {read.data?.items.map((execution) => (
        <details
          key={`${execution.entry_id}:${execution.run_id}:${execution.claim_id}`}
          className="rounded-lg border p-3"
        >
          <summary className="flex min-h-7 cursor-pointer flex-wrap items-center gap-2 max-md:min-h-11 [@media(pointer:coarse)]:min-h-11">
            <PoolState execution={execution} />
            {execution.current && (
              <span className="text-xs text-muted-foreground">{t("taskPool:current")}</span>
            )}
          </summary>
          <div className="mt-3 space-y-3">
            <PoolTimeline execution={execution} />
            <PoolTechnicalDetails execution={execution} />
          </div>
        </details>
      ))}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={cursors.length === 1 || read.loading}
          onClick={() => setCursors((items) => items.slice(0, -1))}
        >
          {t("taskPool:previous")}
        </Button>
        <Button
          variant="outline"
          disabled={!read.data?.next_cursor || read.loading}
          onClick={() => setCursors((items) => [...items, read.data!.next_cursor])}
        >
          {t("taskPool:next")}
        </Button>
      </div>
    </section>
  );
}
