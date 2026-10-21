package handlers

import (
	"testing"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/service"
	"github.com/kandev/kandev/internal/task/statussummary"
	"github.com/stretchr/testify/require"
)

func poolSummaryService(f poolMoveWireFixture) *service.Service {
	return service.NewService(service.Repos{Tasks: f.tasks, StatusSummaries: f.tasks, Workspaces: f.tasks,
		Workflows: f.tasks, TaskRepos: f.tasks, Sessions: f.tasks, Turns: f.tasks, Messages: f.tasks,
		Attachments: f.tasks, Executors: f.tasks, RepoEntities: f.tasks}, nil, f.handler.logger, service.RepositoryDiscoveryConfig{})
}

func rebuildNativePoolSummary(t *testing.T, f poolMoveWireFixture, svc *service.Service) *statussummary.TaskStatusSummary {
	t.Helper()
	task, err := f.tasks.GetTask(f.ctx, f.task.ID)
	require.NoError(t, err)
	loaded, err := svc.GetTaskStatusSummaries(f.ctx, []string{task.ID})
	require.NoError(t, err)
	summaries, err := svc.ReconcileTaskStatusSummaries(f.ctx, []*models.Task{task}, nil, nil, loaded)
	require.NoError(t, err)
	require.NotNil(t, summaries[task.ID])
	return summaries[task.ID]
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolSummaryRebuildUsesNativeClaimsAndAdvancesWithoutTaskMutation(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	svc := poolSummaryService(f)
	before := poolHistorySourceCounts(t, f)
	first := rebuildNativePoolSummary(t, f, svc)
	require.NotNil(t, first.PoolExecution, "原生摘要重建必须读取持久池证据，而非仅保留会话状态")
	require.Equal(t, "claimed", first.PoolExecution.State)
	require.Equal(t, claim.ID, first.PoolExecution.RunID)
	require.Equal(t, claim.ClaimID, first.PoolExecution.ClaimID)
	require.True(t, first.PoolExecution.ClaimedAt.Equal(*claim.ClaimedAt))
	require.Nil(t, first.PoolExecution.StartedAt)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
	// 未启动执行器的历史领取夹具；不把直接更新视为生产恢复入口。
	_, err = f.database.Exec(`UPDATE runs SET status='queued',claimed_at=NULL WHERE id=?`, claim.ID)
	require.NoError(t, err)
	replacement, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, replacement)
	require.NotEqual(t, claim.ClaimID, replacement.ClaimID)
	before = poolHistorySourceCounts(t, f)
	restarted := poolSummaryService(f)
	second := rebuildNativePoolSummary(t, f, restarted)
	require.NotNil(t, second.PoolExecution)
	require.Equal(t, replacement.ClaimID, second.PoolExecution.ClaimID)
	require.Greater(t, second.Revision, first.Revision, "任务行不变时领取变化仍须推进摘要版本")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
	stored, err := f.tasks.LoadTaskStatusSummaries(f.ctx, []string{f.task.ID})
	require.NoError(t, err)
	require.Equal(t, second.PoolExecution, stored[f.task.ID].PoolExecution)
}

func TestPoolSummaryRebuildKeepsUnboundNativeTaskCompatible(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	before := poolHistorySourceCounts(t, f)
	summary := rebuildNativePoolSummary(t, f, poolSummaryService(f))
	require.Nil(t, summary.PoolExecution)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolSummaryRebuildReplacesOldClaimWithNativeClearance(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	f := fixture.f
	first := rebuildNativePoolSummary(t, f, poolSummaryService(f))
	require.NotNil(t, first.PoolExecution)
	fixture.purge(t)
	before := poolHistorySourceCounts(t, f)
	second := rebuildNativePoolSummary(t, f, poolSummaryService(f))
	require.NotNil(t, second.PoolExecution)
	require.Equal(t, "history_cleaned", second.PoolExecution.Reason)
	require.Equal(t, fixture.claimID, second.PoolExecution.ClaimID)
	require.False(t, second.PoolExecution.Current)
	require.Greater(t, second.Revision, first.Revision)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
	stored, err := f.tasks.LoadTaskStatusSummaries(f.ctx, []string{f.task.ID})
	require.NoError(t, err)
	require.Equal(t, second.PoolExecution, stored[f.task.ID].PoolExecution)
}
