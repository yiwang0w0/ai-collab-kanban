"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import { useAppStore } from "@/components/state-provider";
import { useTaskPoolRecovery } from "@/hooks/domains/task/use-task-pool-recovery";
import { getBackendConfig } from "@/lib/config";
import type { PoolRecoveryAction } from "@/lib/types/task-pool-recovery";
import { TaskPoolRecoveryConfirmation } from "./task-pool-recovery-confirmation";

type Props = {
  taskId: string;
  runId: string;
  workspaceId: string;
  title: string;
  fresh: boolean;
  executionVersion: string;
  onRefresh: () => void;
};

function recoveryReason(
  authenticated: boolean,
  fresh: boolean,
  recovery: ReturnType<typeof useTaskPoolRecovery>,
) {
  if (!authenticated) return "signIn";
  if (!fresh) return "stale";
  if (recovery.read.error) return "unavailable";
  if (recovery.read.loading && !recovery.read.data) return "loading";
  return "blocked";
}

export function TaskPoolRecovery({
  taskId,
  runId,
  workspaceId,
  title,
  fresh,
  executionVersion,
  onRefresh,
}: Props) {
  const { t } = useTranslation();
  const userId = useAppStore((state) => state.auth.user?.id);
  const authenticated = useAppStore(
    (state) => state.auth.mode === "enabled" && state.auth.authenticated,
  );
  const scope = JSON.stringify([getBackendConfig().apiBaseUrl, userId, workspaceId, taskId, runId]);
  const recovery = useTaskPoolRecovery({
    taskId,
    runId,
    scope,
    authenticated: authenticated && !!userId,
    fresh,
    executionVersion,
    onCommitted: onRefresh,
  });
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const actions: PoolRecoveryAction[] = ["withdraw", "stop", "retry"];
  const reason = recoveryReason(authenticated && !!userId, fresh, recovery);
  const enabled = actions.some(recovery.canPrepare);
  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid="pool-recovery">
      <h3 className="text-sm font-semibold">{t("taskPool:recoveryTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("taskPool:recoveryReadOnly")}</p>
      {!enabled && (
        <p className="text-xs text-muted-foreground">{t(`taskPool:recovery.${reason}`)}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            variant="outline"
            disabled={!recovery.canPrepare(action)}
            data-testid={`pool-recovery-${action}`}
            onClick={(event) => {
              anchor.current = event.currentTarget;
              if (recovery.prepare(action)) setOpen(true);
            }}
          >
            {t(`taskPool:recovery.action.${action}`)}
          </Button>
        ))}
        <Button
          variant="outline"
          disabled={recovery.status === "sending" || recovery.status === "querying"}
          onClick={() => {
            void recovery.read.refresh();
            onRefresh();
          }}
        >
          {t("taskPool:refresh")}
        </Button>
      </div>
      {recovery.status !== "idle" && (
        <p role="status" className="text-sm" data-testid="pool-recovery-result">
          {t(
            recovery.status === "submitted" && recovery.completedAction === "stop"
              ? "taskPool:recovery.status.stopSubmitted"
              : `taskPool:recovery.status.${recovery.status}`,
          )}
        </p>
      )}
      {recovery.status === "unknown" && (
        <Button
          variant="outline"
          data-testid="pool-recovery-query"
          disabled={!authenticated}
          onClick={() => {
            void recovery.query();
          }}
        >
          {t("taskPool:recovery.query")}
        </Button>
      )}
      <TaskPoolRecoveryConfirmation
        title={title}
        recovery={recovery}
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
      />
    </section>
  );
}
