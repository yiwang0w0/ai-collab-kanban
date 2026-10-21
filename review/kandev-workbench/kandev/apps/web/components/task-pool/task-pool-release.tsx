"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@kandev/ui/select";
import { useAppStore } from "@/components/state-provider";
import { useTaskPoolRelease } from "@/hooks/domains/task/use-task-pool-release";
import type { PoolCard } from "@/lib/types/task-pool";
import { PoolAgent } from "./task-pool-facts";
import { TaskPoolReleaseConfirmation } from "./task-pool-release-confirmation";

type Props = { card: PoolCard; workspaceId: string; fresh: boolean; onRefresh: () => void };

function blockReason(
  authenticated: boolean,
  fresh: boolean,
  release: ReturnType<typeof useTaskPoolRelease>,
  selected: boolean,
) {
  if (!authenticated) return "signIn";
  if (!fresh) return "stale";
  if (release.read.error) return "unavailable";
  if (release.read.loading && !release.read.data) return "loading";
  return selected ? "blocked" : "noTarget";
}

export function TaskPoolRelease({ card, workspaceId, fresh, onRefresh }: Props) {
  const { t } = useTranslation();
  const authenticated = useAppStore(
    (state) => state.auth.mode === "enabled" && state.auth.authenticated,
  );
  const release = useTaskPoolRelease({
    card,
    workspaceId,
    fresh,
    authenticated,
    onCommitted: onRefresh,
  });
  const [choice, setChoice] = useState("");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const selected = release.targets.find((step) => step.id === choice) ?? release.targets[0];
  const available = !!selected && release.canPrepare(selected.id);
  const reason = blockReason(authenticated, fresh, release, !!selected);
  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid="pool-release">
      <h3 className="text-sm font-semibold">{t("taskPool:release.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("taskPool:release.explanation")}</p>
      {release.targets.length > 0 && (
        <Select
          value={selected?.id ?? ""}
          onValueChange={setChoice}
          disabled={!authenticated || release.status === "sending"}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("taskPool:release.target")}
            data-testid="pool-release-target"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {release.targets.map((step) => (
              <SelectItem key={step.id} value={step.id}>
                {step.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {selected && (
        <p className="text-xs text-muted-foreground">
          {t("taskPool:plannedAgent")}: <PoolAgent profileId={selected.agent_profile_id} />
        </p>
      )}
      {!available && (
        <p className="text-xs text-muted-foreground" data-testid="pool-release-reason">
          {t(`taskPool:release.${reason}`)}
        </p>
      )}
      {release.status !== "idle" && (
        <p role="status" className="text-sm" data-testid="pool-release-result">
          {t(`taskPool:release.${release.status}`)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={anchor}
          disabled={!available}
          data-testid="pool-release-prepare"
          onClick={() => {
            if (selected && release.prepare(selected.id)) setOpen(true);
          }}
        >
          {t("taskPool:release.prepare")}
        </Button>
        <Button
          variant="outline"
          disabled={release.status === "sending"}
          onClick={() => {
            void release.read.refresh();
            onRefresh();
          }}
        >
          {t("taskPool:refresh")}
        </Button>
      </div>
      <TaskPoolReleaseConfirmation
        title={card.title}
        release={release}
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
      />
    </section>
  );
}
