"use client";

import { useTranslation } from "react-i18next";
import { Badge } from "@kandev/ui/badge";
import { useAppStore } from "@/components/state-provider";
import { parseTurnTimestamp } from "@/lib/state/slices/session/turn-actions";
import type { PoolExecution } from "@/lib/types/task-pool";
import { poolTimeline } from "@/lib/task-pool-view-model";

export function PoolTime({ at }: { at: string }) {
  const { i18n } = useTranslation();
  const parsed = parseTurnTimestamp(at);
  if (parsed === null) return null;
  const date = new Date(Number(parsed / BigInt(1_000_000)));
  return (
    <time dateTime={at} title={at} className="tabular-nums">
      {new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "medium" }).format(
        date,
      )}
    </time>
  );
}

export function PoolState({ execution }: { execution: PoolExecution | null }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" data-testid="pool-execution-state">
      {execution ? t(`taskPool:states.${execution.state}`) : t("taskPool:notReleased")}
    </Badge>
  );
}

export function PoolAgent({ profileId }: { profileId?: string }) {
  const { t } = useTranslation();
  const profile = useAppStore((state) =>
    state.agentProfiles.items.find((item) => item.id === profileId),
  );
  return (
    <span>{profile?.label ?? t(profileId ? "taskPool:agentUnknown" : "taskPool:unclaimed")}</span>
  );
}

export function PoolTimeline({ execution }: { execution: PoolExecution | null }) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-3 border-l pl-4" data-testid="pool-timeline">
      {poolTimeline(execution).map((point) => (
        <li key={point.kind} data-testid={`pool-time-${point.kind}`} className="text-sm">
          <span className="block font-medium">{t(`taskPool:states.${point.kind}`)}</span>
          <span className="text-muted-foreground">
            <PoolTime at={point.at} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PoolTechnicalDetails({ execution }: { execution: PoolExecution | null }) {
  const { t } = useTranslation();
  if (!execution) return null;
  const ids = {
    entry: execution.entry_id,
    run: execution.run_id,
    claim: execution.claim_id,
    session: execution.session_id,
    execution: execution.execution_id,
    profile: execution.execution_profile_id,
    turn: execution.turn_id,
    operation: execution.operation_id,
    source: execution.operation_source,
    reason: execution.reason,
  };
  return (
    <details className="rounded-lg border p-3">
      <summary className="flex min-h-7 cursor-pointer items-center max-md:min-h-11 [@media(pointer:coarse)]:min-h-11 text-sm font-medium">
        {t("taskPool:technicalDetails")}
      </summary>
      <dl className="mt-2 space-y-1 break-all font-mono text-xs text-muted-foreground">
        {Object.entries(ids)
          .filter(([, value]) => value)
          .map(([key, value]) => (
            <div key={key} className="grid grid-cols-[5rem_1fr] gap-2">
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
