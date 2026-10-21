package statussummary

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/stretchr/testify/require"
)

func TestProjectorPoolExecutionReloadsCommittedFactsAndIgnoresSelfReportedState(t *testing.T) {
	projector, store, _, _, _ := newProjectorTest(t)
	value := PoolExecutionSummary(poolSummaryFixture())
	current := &value
	projector.loadPoolExecution = func(context.Context, string) (*PoolExecutionSummary, error) { return current, nil }
	refresh := func(data map[string]any) {
		t.Helper()
		require.NoError(t, projector.HandleEvent(context.Background(), bus.NewEvent(events.TaskPoolExecutionCommitted, "test", data)))
	}
	refresh(map[string]any{"task_id": "task-pool-refresh", "workspace_id": "PRIVATE-FOREIGN-WORKSPACE", "state": "ended"})
	first := store.summary("task-pool-refresh")
	require.NotNil(t, first.PoolExecution)
	require.Equal(t, "queued", first.PoolExecution.State)
	claimedAt := value.QueuedAt.AddDate(0, 0, 1)
	value.State, value.ClaimID, value.ClaimedAt, value.Current = "claimed", "current-claim", &claimedAt, true
	value.ClaimedAgentProfileID = value.PlannedAgentProfileID
	refresh(map[string]any{"task_id": "task-pool-refresh", "claim_id": "old-claim", "state": "ended"})
	second := store.summary("task-pool-refresh")
	require.Equal(t, "current-claim", second.PoolExecution.ClaimID)
	require.Equal(t, "claimed", second.PoolExecution.State)
	require.Greater(t, second.Revision, first.Revision)
	require.Empty(t, first.PoolExecution.ClaimID, "外部来源对象变化不能回写旧的已确认摘要")
	store.mu.Lock()
	workspace := store.rows["task-pool-refresh"].WorkspaceID
	store.mu.Unlock()
	require.Equal(t, "workspace-1", workspace, "通知自报工作区不参与路由权威")
	current = nil
	refresh(map[string]any{"task_id": "task-pool-refresh"})
	cleared := store.summary("task-pool-refresh")
	require.Nil(t, cleared.PoolExecution, "来源明确返回空时必须清理旧池摘要")
	require.Greater(t, cleared.Revision, second.Revision)
}

func TestProjectorPoolExecutionReadFailureKeepsKnownTimesButMarksUnknown(t *testing.T) {
	projector, store, _, _, _ := newProjectorTest(t)
	value := PoolExecutionSummary(poolSummaryFixture())
	startedAt := value.QueuedAt.AddDate(0, 0, 1)
	value.State, value.ClaimID, value.StartedAt, value.Current = "started", "known-claim", &startedAt, true
	fail := false
	projector.loadPoolExecution = func(context.Context, string) (*PoolExecutionSummary, error) {
		if fail {
			return nil, errors.New("PRIVATE-POOL-SOURCE-DIAGNOSTIC")
		}
		return &value, nil
	}
	refresh := func() {
		t.Helper()
		require.NoError(t, projector.HandleEvent(context.Background(), bus.NewEvent(events.TaskPoolExecutionCommitted, "test", map[string]any{"task_id": "task-pool-read-failure"})))
	}
	refresh()
	fail = true
	refresh()
	got := store.summary("task-pool-read-failure")
	require.NotNil(t, got.PoolExecution)
	require.Equal(t, "unknown", got.PoolExecution.State)
	require.Equal(t, "pool_read_unavailable", got.PoolExecution.Reason)
	require.False(t, got.PoolExecution.Current)
	require.Equal(t, "known-claim", got.PoolExecution.ClaimID)
	require.True(t, got.PoolExecution.StartedAt.Equal(startedAt))
	encoded, err := got.SemanticJSON()
	require.NoError(t, err)
	require.NotContains(t, string(encoded), "PRIVATE-POOL-SOURCE")
}
