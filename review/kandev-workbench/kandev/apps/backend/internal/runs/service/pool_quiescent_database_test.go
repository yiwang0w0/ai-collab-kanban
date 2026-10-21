package service_test

import (
	"context"
	"testing"

	"github.com/jmoiron/sqlx"
	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	"github.com/stretchr/testify/require"
)

type poolDatabaseQuiescenceChecker interface {
	CheckPoolExecutionQuiescentTx(context.Context, *sqlx.Tx, runsmodels.PoolExecutionIdentity) error
}

func poolQuiescentDatabaseFixture(t *testing.T) (poolPublishFixture, runsmodels.PoolExecutionIdentity) {
	t.Helper()
	f, identity, signal := poolActivityFixture(t, "claude-acp")
	// 按真实引导顺序重放字段所有者；旧共享夹具的 task 初始化会重建 tasks，不能把缺列当作空 checkout。
	_, err := officesqlite.NewWithDB(f.runs.Writer(), f.runs.Reader(), nil)
	require.NoError(t, err)
	signal.StartedSource = ""
	_, err = f.svc.ObservePoolExecutionStopped(context.Background(), signal, "standalone_control_v1", "control-instance", true)
	require.NoError(t, err)
	ctx := context.Background()
	running, err := f.tasks.GetExecutorRunningBySessionID(ctx, identity.SessionID)
	require.NoError(t, err)
	require.NoError(t, f.tasks.DeleteExecutorRunningIfCurrent(ctx, identity.SessionID, identity.ExecutionID, running.UpdatedAt))
	require.NoError(t, f.tasks.CompleteTurn(ctx, identity.TurnID))
	require.NoError(t, f.tasks.UpdateTaskSessionState(ctx, identity.SessionID, taskmodels.TaskSessionStateWaitingForInput, ""))
	return f, identity
}

func checkPoolDatabaseQuiescent(t *testing.T, f poolPublishFixture, identity runsmodels.PoolExecutionIdentity) error {
	t.Helper()
	checker, supported := any(f.tasks).(poolDatabaseQuiescenceChecker)
	require.True(t, supported, "原生任务仓储缺少限定执行的占用核验")
	tx, err := f.runs.Writer().BeginTxx(context.Background(), nil)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback() }()
	return checker.CheckPoolExecutionQuiescentTx(context.Background(), tx, identity)
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolDatabaseQuiescenceUsesClosedNativeScopeWithoutMutatingTask(t *testing.T) {
	f, identity := poolQuiescentDatabaseFixture(t)
	before, err := f.tasks.GetTask(context.Background(), identity.TaskID)
	require.NoError(t, err)
	require.NoError(t, checkPoolDatabaseQuiescent(t, f, identity))
	after, err := f.tasks.GetTask(context.Background(), identity.TaskID)
	require.NoError(t, err)
	require.Equal(t, before, after, "占用核验本身不能清 checkout、改版本或完成主卡")
	claim, err := f.runs.ResolveCurrentPoolClaim(context.Background(), identity.RunID)
	require.NoError(t, err)
	require.Equal(t, identity.ClaimID, claim.ClaimID)
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolDatabaseQuiescenceRejectsLiveOrForeignOwnership(t *testing.T) {
	for _, mode := range []string{"open-turn", "running-session", "unknown-session", "live-inventory", "foreign-checkout", "checkout-timestamp", "wrong-task", "wrong-profile", "wrong-turn", "wrong-session"} {
		t.Run(mode, func(t *testing.T) {
			f, identity := poolQuiescentDatabaseFixture(t)
			switch mode {
			case "open-turn":
				mustPoolAllocationExec(t, f, `UPDATE task_session_turns SET completed_at=NULL WHERE id=?`, identity.TurnID)
			case "running-session":
				require.NoError(t, f.tasks.UpdateTaskSessionState(context.Background(), identity.SessionID, taskmodels.TaskSessionStateRunning, ""))
			case "unknown-session":
				mustPoolAllocationExec(t, f, `UPDATE task_sessions SET state='unrecognized' WHERE id=?`, identity.SessionID)
			case "live-inventory":
				require.NoError(t, f.tasks.UpsertExecutorRunning(context.Background(), &taskmodels.ExecutorRunning{ID: "replacement-runtime", TaskID: identity.TaskID, SessionID: identity.SessionID, AgentExecutionID: "replacement-execution", ExecutionProfileID: identity.ExecutionProfileID, ExecutorID: taskmodels.ExecutorIDWorktree, Status: taskmodels.ExecutorRunningStatusRunning}))
			case "foreign-checkout":
				mustPoolAllocationExec(t, f, `UPDATE tasks SET checkout_agent_id='other-agent',checkout_run_id='other-run',checkout_at=CURRENT_TIMESTAMP WHERE id=?`, identity.TaskID)
			case "checkout-timestamp":
				mustPoolAllocationExec(t, f, `UPDATE tasks SET checkout_at=CURRENT_TIMESTAMP WHERE id=?`, identity.TaskID)
			case "wrong-task":
				identity.TaskID = "other-task"
			case "wrong-profile":
				identity.AgentProfileID = "other-profile"
			case "wrong-turn":
				identity.TurnID = "other-turn"
			case "wrong-session":
				identity.SessionID = "other-session"
			}
			require.Error(t, checkPoolDatabaseQuiescent(t, f, identity))
		})
	}
}
