package orchestrator

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

func TestPoolProjectionHistoryCleanupIsNotSuppressedByQueuedStamp(t *testing.T) {
	eventBus := bus.NewMemoryEventBus(logger.Default())
	svc := &Service{eventBus: eventBus, logger: logger.Default()}
	t.Cleanup(func() {
		svc.stopDynamicSuccessorWorkers()
		svc.dynamicSuccessorWorkers.Wait()
		eventBus.Close()
	})
	var calls atomic.Int64
	_, err := eventBus.Subscribe(events.TaskPoolExecutionCommitted, func(context.Context, *bus.Event) error {
		calls.Add(1)
		return nil
	})
	require.NoError(t, err)
	change := runsmodels.PoolProjectionCommit{TaskID: "cleanup-task", RunID: "cleanup-run", Kind: "queued"}
	svc.ObservePoolCommit(change)
	svc.dynamicSuccessorWorkers.Wait()
	require.EqualValues(t, 1, calls.Load())
	change.Kind = "history_cleaned"
	svc.ObservePoolCommit(change)
	svc.dynamicSuccessorWorkers.Wait()
	require.EqualValues(t, 2, calls.Load(), "清理没有新的 run_events 序号，不能被入队的零序号吞掉")
	svc.ObservePoolCommit(change)
	svc.dynamicSuccessorWorkers.Wait()
	require.EqualValues(t, 2, calls.Load(), "重复清理提示仍应去重")
}
