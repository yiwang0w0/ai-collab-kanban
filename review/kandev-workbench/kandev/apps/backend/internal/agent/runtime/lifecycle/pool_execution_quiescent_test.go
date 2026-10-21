package lifecycle

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/agent/runtime/activity"
	"github.com/stretchr/testify/require"
)

type poolRuntimeQuiescenceChecker interface {
	CheckExecutionQuiescent(context.Context, string, string, string) error
}

func poolRuntimeQuiescenceCheckerFor(t *testing.T, manager *Manager) poolRuntimeQuiescenceChecker {
	t.Helper()
	checker, supported := any(manager).(poolRuntimeQuiescenceChecker)
	require.True(t, supported, "原生运行时缺少执行范围的当前占用核验")
	return checker
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolRuntimeQuiescenceChecksActualStoppedScopeWithoutMoreControlIO(t *testing.T) {
	f := newNativePoolStopFixture(t, "success", true)
	require.NoError(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, "pool-confirmed-stop", false))
	checker := poolRuntimeQuiescenceCheckerFor(t, f.manager)
	require.NoError(t, checker.CheckExecutionQuiescent(context.Background(), f.execution.ID, f.execution.TaskID, f.execution.SessionID))
	require.EqualValues(t, 2, f.control.gets.Load())
	require.EqualValues(t, 1, f.control.deletes.Load(), "当前占用核验不能再次调用停止器")
}

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolRuntimeQuiescenceRejectsCurrentOrUnknownOwnership(t *testing.T) {
	for _, mode := range []string{"live-execution", "pending-owner", "missing-coordinator", "task-orphan", "task-without-session", "session-orphan", "empty-task", "empty-session", "empty-execution"} {
		t.Run(mode, func(t *testing.T) {
			f := newNativePoolStopFixture(t, "success", true)
			if mode == "pending-owner" {
				claim, err := f.manager.ensureExecutionActivity(context.Background(), f.execution.ID, activity.KindExecutionRunning)
				require.NoError(t, err)
				t.Cleanup(claim.Release)
			}
			if mode != "live-execution" {
				require.NoError(t, f.manager.StopAgentWithReason(context.Background(), f.execution.ID, "pool-confirmed-stop", false))
			}
			executionID, taskID, sessionID := f.execution.ID, f.execution.TaskID, f.execution.SessionID
			switch mode {
			case "missing-coordinator":
				f.manager.SetActivityCoordinator(nil)
			case "task-orphan":
				require.NoError(t, f.manager.executionStore.Add(createTestExecution("other-execution", taskID, "other-session")))
			case "task-without-session":
				require.NoError(t, f.manager.executionStore.Add(createTestExecution("unindexed-execution", taskID, "")))
			case "session-orphan":
				require.NoError(t, f.manager.executionStore.Add(createTestExecution("other-execution", "other-task", sessionID)))
			case "empty-task":
				taskID = ""
			case "empty-session":
				sessionID = ""
			case "empty-execution":
				executionID = ""
			}
			require.Error(t, poolRuntimeQuiescenceCheckerFor(t, f.manager).CheckExecutionQuiescent(context.Background(), executionID, taskID, sessionID))
		})
	}
}
