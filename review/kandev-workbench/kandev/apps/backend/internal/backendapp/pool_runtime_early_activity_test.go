package backendapp

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	"github.com/kandev/kandev/internal/orchestrator/executor"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolFirstActivityCanBePersistedBeforeStartAPIReturns(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	paused, release, abort := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var pauseOnce, releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }); close(abort) })
	subscription, err := f.eventBus.Subscribe(events.MessageAdded, func(ctx context.Context, event *bus.Event) error {
		data, ok := event.Data.(map[string]interface{})
		if !ok || data["task_id"] != f.task.ID || data["author_type"] != "user" {
			return nil
		}
		pauseOnce.Do(func() { close(paused) })
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, subscription.Unsubscribe()) })
	var request atomic.Pointer[executor.LaunchAgentRequest]
	previousLaunch := f.agentMgr.launchHook
	f.agentMgr.launchHook = func(ctx context.Context, req *executor.LaunchAgentRequest, response *executor.LaunchAgentResponse) error {
		if err := previousLaunch(ctx, req, response); err != nil {
			return err
		}
		request.Store(req)
		return nil
	}
	processed := make(chan error, 1)
	f.agentMgr.startHook = func(ctx context.Context, id string) error {
		select {
		case <-paused:
		case <-abort:
			return context.Canceled
		case <-ctx.Done():
			return ctx.Err()
		}
		err := publishPoolFirstMockActivity(ctx, f, request.Load(), id)
		processed <- err
		return err
	}
	result := startPoolAPIInBackground(t, f, func() { releaseOnce.Do(func() { close(release) }) })
	select {
	case <-paused:
	case <-time.After(5 * time.Second):
		t.Fatal("原生启动没有停在提交后的用户消息发布边界")
	}
	require.Eventually(t, func() bool {
		var count int
		err := f.db.Get(&count, `SELECT COUNT(*) FROM run_events WHERE run_id = ? AND event_type = 'pool.work-observed.v1'`, f.claim.ID)
		return err == nil && count == 1
	}, 5*time.Second, 10*time.Millisecond, "父调用仍未返回时，早到的首帧必须已有可信开工证据")
	select {
	case err := <-result:
		t.Fatalf("测试边界释放前 API 不能返回: %v", err)
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-result:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("原生启动没有完成")
	}
	select {
	case err := <-processed:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("模拟首帧没有完成处理")
	}
}

func startPoolAPIInBackground(t *testing.T, f poolRuntimeFixture, release func()) <-chan error {
	t.Helper()
	result, done := make(chan error, 1), make(chan struct{})
	t.Cleanup(func() {
		release()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("原生启动测试协程没有退出")
		}
	})
	go func() {
		defer close(done)
		_, err := f.orchestrator.StartPoolTask(t.Context(), f.claim)
		result <- err
	}()
	return result
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolAllocationWriteFailureStopsNativeStartBeforeMockProcess(t *testing.T) {
	f := newPoolRuntimeFixture(t)
	_, err := f.db.Exec(`CREATE TRIGGER fail_native_pool_allocation BEFORE INSERT ON run_events
		WHEN NEW.event_type = 'pool.execution-allocated.v1' BEGIN SELECT RAISE(ABORT, 'allocation-failure'); END`)
	require.NoError(t, err)
	var starts atomic.Int32
	f.agentMgr.startHook = func(context.Context, string) error { starts.Add(1); return nil }
	execution, err := f.orchestrator.StartPoolTask(context.Background(), f.claim)
	require.Error(t, err)
	require.Nil(t, execution)
	require.Zero(t, starts.Load(), "纯数据库写入拒绝不能启动模拟进程")
	current, err := f.officeRepo.RunsRepository().ResolveCurrentPoolClaim(context.Background(), f.claim.ID)
	require.NoError(t, err)
	require.Equal(t, f.claim.ClaimID, current.ClaimID)
	require.Empty(t, current.SessionID, "分配失败必须回滚运行会话关联")
	events, err := f.officeRepo.RunsRepository().ListRunEvents(context.Background(), f.claim.ID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 1, "只能保留原启动意图，不能重新派发或补造活动")
}
