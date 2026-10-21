package orchestrator

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/orchestrator/executor"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type poolRecoveryStopper interface {
	WithPoolRecoveryStop(context.Context, runsmodels.PoolExecutionIdentity, func(context.Context) (bool, error)) error
}

func poolRecoveryStopperFor(t *testing.T, service *Service) poolRecoveryStopper {
	t.Helper()
	stopper, ok := any(service).(poolRecoveryStopper)
	require.True(t, ok, "缺少绑定原生生命周期的精确执行停止接缝")
	return stopper
}

// @covers AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryStopNativeFencesReleaseBeforeExactCapturedIO(t *testing.T) {
	repo := setupTestRepo(t)
	seedSession(t, repo, "t1", "s1", "step1")
	service := createTestService(repo, newMockStepGetter(), newMockTaskRepo())
	t.Cleanup(service.stopDynamicSuccessorWorkers)
	identity := poolQuiescentIdentity()
	identity.TaskID, identity.SessionID = "t1", "s1"
	var current atomic.Value
	current.Store(identity.ExecutionID)
	stopped := make(chan string, 1)
	manager := &mockAgentManager{}
	manager.getExecutionIDForSessionFunc = func(context.Context, string) (string, error) { return current.Load().(string), nil }
	manager.stopAgentWithReasonFunc = func(ctx context.Context, executionID, _ string, _ bool) error {
		unlock, acquired := service.tryAcquireSessionLifecycleLock(identity.SessionID)
		if acquired {
			unlock()
		}
		if !acquired {
			stopped <- "lifecycle-still-held"
			return nil
		}
		return service.WithPoolEnqueueAdmission(ctx, identity.TaskID, func(context.Context, bool) error {
			stopped <- executionID
			return nil
		})
	}
	service.agentManager = manager
	service.executor = executor.NewExecutor(manager, repo, logger.Default(), executor.ExecutorConfig{})
	err := poolRecoveryStopperFor(t, service).WithPoolRecoveryStop(context.Background(), identity, func(ctx context.Context) (bool, error) {
		require.True(t, ceilingEntryAdmissionLockHeld(ctx, identity.TaskID))
		unlock, acquired := service.tryAcquireSessionLifecycleLock(identity.SessionID)
		if acquired {
			unlock()
		}
		require.False(t, acquired)
		current.Store("replacement-execution")
		return true, nil
	})
	require.NoError(t, err)
	select {
	case actual := <-stopped:
		require.Equal(t, identity.ExecutionID, actual, "提交后只停止捕获身份，不能重新按 session 查替换执行")
	case <-time.After(5 * time.Second):
		t.Fatal("停止未交给原生受关闭管理的后续工作")
	}
}

func TestPoolRecoveryStopScopesBeforeAnyNativeDependency(t *testing.T) {
	denied := errors.New("private-task")
	service := &Service{}
	service.SetSessionAccessChecker(func(context.Context, string) error { return denied })
	err := poolRecoveryStopperFor(t, service).WithPoolRecoveryStop(context.Background(), poolQuiescentIdentity(), nil)
	require.ErrorIs(t, err, denied)
}
