"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import TaskLink from "@/components/routing/task-link";
import { usePoolRead } from "@/hooks/domains/task/use-task-pool";
import { getTaskDependencies } from "@/lib/api/domains/task-dependencies-api";
import type { PoolCard } from "@/lib/types/task-pool";
import { PoolTime } from "./task-pool-facts";

export function TaskPoolRelations({ card, children }: { card: PoolCard; children: PoolCard[] }) {
  const { t } = useTranslation();
  const read = usePoolRead(`relations:${card.task_id}`, (signal) =>
    getTaskDependencies(card.task_id, { init: { signal } }),
  );
  const task = read.data;
  return (
    <section className="space-y-2" data-testid="pool-relations">
      <h3 className="text-sm font-semibold">{t("taskPool:relations")}</h3>
      {read.error ? (
        <p role="alert" className="text-xs text-destructive">
          {t("taskPool:unavailable")}
        </p>
      ) : null}
      {card.relations.parent_id && (
        <RelationLink taskId={card.relations.parent_id} label={t("taskPool:parent")} />
      )}
      {task?.depends_on?.map((dependency) => (
        <RelationLink
          key={dependency.id}
          taskId={dependency.id}
          label={`${t("taskPool:dependsOn")}: ${dependency.title ?? t("taskPool:dependsOn")}`}
        />
      ))}
      {task?.blocks?.map((dependency) => (
        <RelationLink
          key={dependency.id}
          taskId={dependency.id}
          label={`${t("taskPool:blocks")}: ${dependency.title ?? t("taskPool:blocks")}`}
        />
      ))}
      {children.map((child) => (
        <RelationLink
          key={child.task_id}
          taskId={child.task_id}
          label={`${t("taskPool:children")}: ${child.title}`}
        />
      ))}
      {card.relations.child_count > children.length && (
        <RelationLink
          taskId={card.task_id}
          label={t("taskPool:moreChildren", {
            count: card.relations.child_count - children.length,
          })}
        />
      )}
      {card.relations.parent_id === "" &&
        card.relations.child_count === 0 &&
        card.relations.depends_on_count === 0 &&
        card.relations.blocks_count === 0 && (
          <p className="text-xs text-muted-foreground">{t("taskPool:noRelations")}</p>
        )}
      {task?.status_summary?.last_activity_at && (
        <p className="pt-2 text-xs text-muted-foreground">
          {t("taskPool:lastActivity")}
          <br />
          <PoolTime at={task.status_summary.last_activity_at} />
        </p>
      )}
    </section>
  );
}

function RelationLink({ taskId, label }: { taskId: string; label: string }) {
  return (
    <Button asChild variant="outline" className="max-w-full justify-start">
      <TaskLink taskId={taskId} className="truncate">
        {label}
      </TaskLink>
    </Button>
  );
}
