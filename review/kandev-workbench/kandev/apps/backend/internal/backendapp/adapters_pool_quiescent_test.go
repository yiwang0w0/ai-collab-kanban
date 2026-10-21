package backendapp

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/agent/runtime/activity"
	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	orchestratorexecutor "github.com/kandev/kandev/internal/orchestrator/executor"
	"github.com/stretchr/testify/require"
)

type poolNativeQuiescenceChecker interface {
	CheckExecutionQuiescent(context.Context, string, string, string) error
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolLifecycleAdapterForwardsActualResourceAdmission(t *testing.T) {
	mgr := lifecycle.NewManager(nil, nil, nil, nil, nil, nil, lifecycle.ExecutorFallbackDeny, t.TempDir(), newTestLogger())
	var client orchestratorexecutor.AgentManagerClient = newLifecycleAdapter(mgr, nil, newTestLogger())
	checker, supported := client.(poolNativeQuiescenceChecker)
	require.True(t, supported, "生产适配器缺少原生当前占用核验，不能只让测试替身提供")
	ctx := context.Background()
	require.Error(t, checker.CheckExecutionQuiescent(ctx, "execution", "task", "session"), "无协调器不等于已释放")
	mgr.SetActivityCoordinator(activity.NewCoordinator(activity.Options{}))
	require.NoError(t, checker.CheckExecutionQuiescent(ctx, "execution", "task", "session"))
	require.NoError(t, mgr.ExecutionStoreForTesting().Add(&lifecycle.AgentExecution{ID: "execution", TaskID: "task", SessionID: "session"}))
	require.Error(t, checker.CheckExecutionQuiescent(ctx, "execution", "task", "session"), "必须转发真实内存占用，不能固定放行")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	require.ErrorIs(t, checker.CheckExecutionQuiescent(cancelled, "missing", "other-task", "other-session"), context.Canceled)
}
