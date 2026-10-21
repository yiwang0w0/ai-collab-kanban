"use client";

import { useTranslation } from "react-i18next";
import { poolCardTimes, poolReasonGroup } from "@/lib/task-pool-view-model";
import type { PoolCard } from "@/lib/types/task-pool";
import { cn } from "@/lib/utils";
import { PoolAgent, PoolState, PoolTime } from "./task-pool-facts";

export function TaskPoolCard({
  card,
  selected,
  onSelect,
}: {
  card: PoolCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const execution = card.pool_execution;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={`pool-card-${card.task_id}`}
      className={cn(
        "w-full cursor-pointer rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-primary",
        selected && "border-primary bg-accent/30",
      )}
    >
      <h2 className="break-words text-sm font-semibold">{card.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {t("taskPool:stage")}: {card.stage}
        </span>
        <PoolState execution={execution} />
      </div>
      <p className="mt-3 text-xs">
        <span className="text-muted-foreground">{t("taskPool:actualAgent")}: </span>
        <PoolAgent profileId={execution?.claimed_agent_profile_id} />
      </p>
      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {poolCardTimes(execution).map((point) => (
          <p key={point.kind}>
            {t(`taskPool:states.${point.kind}`)} · <PoolTime at={point.at} />
          </p>
        ))}
      </div>
      <p className="mt-3 break-words text-xs text-muted-foreground">
        {t(`taskPool:reasons.${poolReasonGroup(card.eligibility.reason)}`)}
      </p>
      {(card.relations.parent_id ||
        card.relations.depends_on_count > 0 ||
        card.relations.child_count > 0) && (
        <div className="mt-3 flex flex-wrap gap-3 border-t pt-2 text-xs text-muted-foreground">
          {card.relations.parent_id && <span>{t("taskPool:parent")}</span>}
          {card.relations.child_count > 0 && (
            <span>
              {t("taskPool:children")}: {card.relations.child_count}
            </span>
          )}
          {card.relations.depends_on_count > 0 && (
            <span>
              {t("taskPool:dependsOn")}: {card.relations.depends_on_count}
            </span>
          )}
        </div>
      )}
    </button>
  );
}
