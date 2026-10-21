package handlers

import (
	"context"
	"testing"

	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/kandev/kandev/internal/task/service"
	"github.com/kandev/kandev/internal/task/statussummary"
	"github.com/stretchr/testify/require"
)

type poolSummaryCASStore struct {
	*tasksqlite.Repository
	before func(context.Context, *statussummary.StoredTaskStatusSummary) (bool, error)
}

func (r *poolSummaryCASStore) CompareAndUpdateTaskStatusSummary(ctx context.Context, row *statussummary.StoredTaskStatusSummary) (bool, error) {
	if row.Summary.PoolExecution != nil && r.before != nil {
		callback := r.before
		r.before = nil
		return callback(ctx, row)
	}
	return r.Repository.CompareAndUpdateTaskStatusSummary(ctx, row)
}

func TestPoolSummaryReconcileRechecksNativeClaimAfterCASLoss(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	first, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, first)
	before := poolHistorySourceCounts(t, f)
	reader := poolSummaryService(f)
	store := &poolSummaryCASStore{Repository: f.tasks}
	var replacementID string
	store.before = func(ctx context.Context, attempted *statussummary.StoredTaskStatusSummary) (bool, error) {
		// 在投影读完旧领取后，原生领取和另一个摘要写者先提交；不调用执行器。
		_, err := f.database.Exec(`UPDATE runs SET status='queued',claimed_at=NULL WHERE id=?`, first.ID)
		require.NoError(t, err)
		replacement, err := f.runs.ClaimNextEligibleRunWithClaim(ctx)
		require.NoError(t, err)
		require.NotNil(t, replacement)
		replacementID = replacement.ClaimID
		latest, err := reader.GetPoolExecutionSummary(ctx, f.task.ID)
		require.NoError(t, err)
		winner := *attempted
		winner.Summary.PoolExecution = latest
		winner.Summary.Git = &statussummary.GitSummary{Additions: 9}
		accepted, err := f.tasks.CompareAndUpdateTaskStatusSummary(ctx, &winner)
		require.NoError(t, err)
		require.True(t, accepted)
		return false, nil
	}
	svc := service.NewService(service.Repos{Tasks: f.tasks, StatusSummaries: store, Workspaces: f.tasks,
		Workflows: f.tasks, TaskRepos: f.tasks, Sessions: f.tasks, Turns: f.tasks, Messages: f.tasks,
		Attachments: f.tasks, Executors: f.tasks, RepoEntities: f.tasks}, nil, f.handler.logger, service.RepositoryDiscoveryConfig{})
	got := rebuildNativePoolSummary(t, f, svc)
	require.NotEmpty(t, replacementID)
	require.NotEqual(t, first.ClaimID, replacementID)
	require.NotNil(t, got.PoolExecution)
	require.Equal(t, replacementID, got.PoolExecution.ClaimID, "CAS 失败不能把旧领取写成更高摘要版本")
	require.Equal(t, &statussummary.GitSummary{Additions: 9}, got.Git, "只合并池字段，不擦掉赢家的其他域")
	after := poolHistorySourceCounts(t, f)
	require.Equal(t, before.TaskState, after.TaskState)
	require.Equal(t, before.UpdatedAt, after.UpdatedAt, "领取重建和摘要 CAS 都不应改写主卡版本")
}
