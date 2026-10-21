package service_test

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	taskmodels "github.com/kandev/kandev/internal/task/models"
)

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchPublicationRejectsDifferentStoredBinding(t *testing.T) {
	cases := []struct {
		name   string
		update string
	}{
		{"reason", `UPDATE runs SET reason = 'queue_run' WHERE id = ?`},
		{"actor_kind", `UPDATE runs SET actor_kind = 'system' WHERE id = ?`},
		{"actor_id", `UPDATE runs SET actor_id = 'another-human' WHERE id = ?`},
		{"merged_row", `UPDATE runs SET coalesced_count = 2 WHERE id = ?`},
		{"wave", `UPDATE runs SET wake_wave_key = 'not-pool' WHERE id = ?`},
		{"unknown_state", `UPDATE runs SET status = 'unknown' WHERE id = ?`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newPoolPublishFixture(t)
			ctx := context.Background()
			_, original, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
			if err != nil || original == nil {
				t.Fatalf("正对照应可入队: %v", err)
			}
			<-f.svc.SubscribeSignal()
			if _, err := f.runs.Writer().Exec(tc.update, original.ID); err != nil {
				t.Fatal(err)
			}
			outcome, row, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
			if !errors.Is(err, runsservice.ErrPoolDispatchConflict) || row != nil || outcome != "" {
				t.Fatalf("同键而绑定不同不能作为成功去重: outcome=%s row_present=%t err=%v", outcome, row != nil, err)
			}
			select {
			case <-f.svc.SubscribeSignal():
				t.Fatal("冲突后不能触发执行")
			default:
			}
		})
	}
}

func TestPoolDispatchPublicationRejectsProfileWorkspaceDrift(t *testing.T) {
	f := newPoolPublishFixture(t)
	if _, err := f.runs.Writer().Exec(`UPDATE agent_profiles SET workspace_id = 'another-workspace' WHERE id = ?`, f.step.AgentProfileID); err != nil {
		t.Fatal(err)
	}
	outcome, row, err := f.publisher.QueuePoolRunAndReturn(context.Background(), f.task.ID, f.release.EntryID)
	if !errors.Is(err, taskmodels.ErrPoolExecutionUnavailable) || row != nil || outcome != "" {
		t.Fatalf("不能把已批准的任务发布到 Profile 的其他工作区: %s %t %v", outcome, row != nil, err)
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 0 {
		t.Fatalf("冲突应回滚整个入队，不消耗幂等键: %d %v", count, err)
	}
	if _, err := f.runs.Writer().Exec(`UPDATE agent_profiles SET workspace_id = '' WHERE id = ?`, f.step.AgentProfileID); err != nil {
		t.Fatal(err)
	}
	if outcome, run, err := f.publisher.QueuePoolRunAndReturn(context.Background(), f.task.ID, f.release.EntryID); err != nil || run == nil || outcome != "queued" || run.WorkspaceID != f.task.WorkspaceID {
		t.Fatalf("全局 CLI Profile 的正对照应从真实任务取得工作区: %s %t %v", outcome, run != nil, err)
	}
}

func TestPoolDispatchPublicationBusyErrorLinksToExistingRun(t *testing.T) {
	f := newPoolPublishFixture(t)
	ctx := context.Background()
	_, first, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || first == nil {
		t.Fatal(err)
	}
	f.seedTerminalPoolRun(t, first.ID)
	entry := f.reenterPool(t)
	// 模拟旧版存量：当前批准与旧活跃运行并存，新提交路径已禁止该状态。
	if _, err := f.runs.Writer().Exec(`UPDATE runs SET status = 'queued', finished_at = NULL WHERE id = ?`, first.ID); err != nil {
		t.Fatal(err)
	}
	_, _, err = f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, entry)
	var busy *runsmodels.PoolTaskBusyError
	if !errors.As(err, &busy) || busy.RunID != first.ID {
		t.Fatalf("冲突应指向当前占用运行: %v", err)
	}
}
