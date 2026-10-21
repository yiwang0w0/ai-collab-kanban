package handlers

import (
	"context"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type poolRetentionNotifier interface {
	SetPoolProjectionObserver(func(runsmodels.PoolProjectionCommit))
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryRetentionNotifiesOnlyAfterCommitAndRebuildsStoredSummary(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	f := fixture.f
	first := rebuildNativePoolSummary(t, f, poolSummaryService(f))
	notifier, ok := any(fixture.cleaner).(poolRetentionNotifier)
	require.True(t, ok, "原生清理尚未接入摘要提交后失效链路")
	changes := make(chan runsmodels.PoolProjectionCommit, 2)
	notifier.SetPoolProjectionObserver(func(change runsmodels.PoolProjectionCommit) {
		// 单连接夹具：在事务内触发通知将无法读取，不能把异步入队当成提交证明。
		ctx, cancel := context.WithTimeout(f.ctx, 3*time.Second)
		defer cancel()
		var count int
		require.NoError(t, f.database.GetContext(ctx, &count, `SELECT COUNT(*) FROM runs WHERE id=?`, fixture.runID))
		require.Zero(t, count)
		require.NoError(t, f.database.GetContext(ctx, &count, `SELECT COUNT(*) FROM run_pool_history_clearances WHERE run_id=?`, fixture.runID))
		require.Equal(t, 1, count)
		changes <- change
		rebuildNativePoolSummary(t, f, poolSummaryService(f))
	})
	fixture.purge(t)
	select {
	case change := <-changes:
		require.Equal(t, f.task.ID, change.TaskID)
		require.Equal(t, fixture.runID, change.RunID)
		require.Equal(t, "history_cleaned", change.Kind)
	case <-time.After(5 * time.Second):
		t.Fatal("已提交的原生清理未触发摘要重建")
	}
	stored, err := f.tasks.LoadTaskStatusSummaries(f.ctx, []string{f.task.ID})
	require.NoError(t, err)
	require.Greater(t, stored[f.task.ID].Revision, first.Revision)
	require.Equal(t, "history_cleaned", stored[f.task.ID].PoolExecution.Reason)
	require.Equal(t, fixture.claimID, stored[f.task.ID].PoolExecution.ClaimID)
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryRetentionRollbackDoesNotPublishSuccessfulCleanup(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	notifier, ok := any(fixture.cleaner).(poolRetentionNotifier)
	require.True(t, ok, "原生清理尚未接入摘要提交后失效链路")
	changes := make(chan runsmodels.PoolProjectionCommit, 2)
	notifier.SetPoolProjectionObserver(func(change runsmodels.PoolProjectionCommit) { changes <- change })
	_, err := fixture.f.database.Exec(`CREATE TRIGGER fixture_refresh_failure BEFORE DELETE ON run_events
		BEGIN SELECT RAISE(ABORT,'fixture refresh failure'); END`)
	require.NoError(t, err)
	_, err = fixture.cleaner.DeleteRunBatch(fixture.f.ctx, fixture.f.database, fixture.cutoff, 0, 100)
	require.Error(t, err)
	require.Empty(t, changes)
	_, err = fixture.f.database.Exec(`DROP TRIGGER fixture_refresh_failure`)
	require.NoError(t, err)
	fixture.purge(t)
	require.Len(t, changes, 1, "解除同一原生故障后必须实际通知，不能用始终不发送证明回滚保护")
}
