package statussummary

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/stretchr/testify/require"
)

func TestTaskStatusSummaryPoolExecutionRebuildKeepsAuthoritativeFacts(t *testing.T) {
	pool := PoolExecutionSummary(poolSummaryFixture())
	encoded, err := json.Marshal(struct {
		PoolExecution         *PoolExecutionSummary
		PoolExecutionObserved bool
		Now                   time.Time
	}{&pool, true, time.Date(2026, 10, 19, 3, 0, 0, 0, time.UTC)})
	require.NoError(t, err)
	var input RebuildInput
	require.NoError(t, json.Unmarshal(encoded, &input))
	got := BuildFromAuthoritative(input)
	require.NotNil(t, got.PoolExecution, "重启重建应携带与有界读视图相同的事实")
	require.Equal(t, pool, *got.PoolExecution)
}

func TestProjectorPoolExecutionSurvivesUnrelatedQueueEventWithoutProvider(t *testing.T) {
	projector, store, _, _, _ := newProjectorTest(t)
	base := decodePoolSummaryWire(t, poolSummaryFixture())
	accepted, err := store.CompareAndUpdateTaskStatusSummary(context.Background(), &StoredTaskStatusSummary{
		TaskID: "task-pool-summary", WorkspaceID: "workspace-1", Summary: base,
	})
	require.NoError(t, err)
	require.True(t, accepted)
	projector.countQueuedPrompts = func(context.Context, string) (int, error) { return 2, nil }
	require.NoError(t, projector.HandleEvent(context.Background(), bus.NewEvent(events.MessageQueueStatusChanged, "test", map[string]any{
		"task_id": "task-pool-summary", "workspace_id": "workspace-1",
	})))
	got := store.summary("task-pool-summary")
	require.NotNil(t, got)
	require.Equal(t, 2, got.QueuedPromptCount, "正对照确认事件确实更新了同一份摘要")
	require.NotNil(t, got.PoolExecution, "无关提示队列事件不应抹掉池事实")
	require.Equal(t, base.PoolExecution, got.PoolExecution)
}

func TestTaskStatusSummaryPoolExecutionRejectsInvalidUTF8Struct(t *testing.T) {
	pool := PoolExecutionSummary(poolSummaryFixture())
	pool.OperationID = string([]byte{0xff})
	require.Error(t, (TaskStatusSummary{PoolExecution: &pool}).Validate())
}
