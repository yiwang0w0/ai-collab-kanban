package orchestrator

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPoolProjectionNotificationLeavesPublisherAndDeduplicatesReceipt(t *testing.T) {
	eventBus := bus.NewMemoryEventBus(logger.Default())
	svc := &Service{eventBus: eventBus, logger: logger.Default()}
	entered, release := make(chan struct{}), make(chan struct{})
	var unlock sync.Once
	var calls atomic.Int64
	t.Cleanup(func() {
		unlock.Do(func() { close(release) })
		svc.stopDynamicSuccessorWorkers()
		svc.dynamicSuccessorWorkers.Wait()
		eventBus.Close()
	})
	_, err := eventBus.Subscribe(events.TaskPoolExecutionCommitted, func(ctx context.Context, event *bus.Event) error {
		assert.Equal(t, map[string]any{"task_id": "task-pool-notify"}, event.Data)
		if calls.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		return nil
	})
	require.NoError(t, err)
	change := runsmodels.PoolProjectionCommit{TaskID: "task-pool-notify", RunID: "run", ClaimID: "claim", Sequence: 2}
	returned := make(chan struct{})
	go func() { svc.ObservePoolCommit(change); close(returned) }()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("投影查询被阻塞时，原生提交发布者仍须可以退出")
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("已接受的提交后刷新没有到达读投影")
	}
	svc.ObservePoolCommit(change)
	change.Sequence = 3
	svc.ObservePoolCommit(change)
	unlock.Do(func() { close(release) })
	svc.dynamicSuccessorWorkers.Wait()
	require.Equal(t, int64(2), calls.Load(), "同一不可变回执不因重复帧重复触发读刷新")
	svc.stopDynamicSuccessorWorkers()
	change.Sequence = 4
	svc.ObservePoolCommit(change)
	svc.dynamicSuccessorWorkers.Wait()
	require.Equal(t, int64(2), calls.Load(), "关闭后不能留下新的后台刷新")
}
