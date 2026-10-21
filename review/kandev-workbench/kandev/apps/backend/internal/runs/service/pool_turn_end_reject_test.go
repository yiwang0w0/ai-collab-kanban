package service_test

import (
	"context"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolTurnEndCannotAdoptStaleOrForeignExecution(t *testing.T) {
	changes := map[string]func(*runsmodels.PoolExecutionActivity){
		"task":              func(a *runsmodels.PoolExecutionActivity) { a.TaskID = "other-task" },
		"profile":           func(a *runsmodels.PoolExecutionActivity) { a.AgentProfileID = "other-profile" },
		"session":           func(a *runsmodels.PoolExecutionActivity) { a.SessionID = "old-session" },
		"execution":         func(a *runsmodels.PoolExecutionActivity) { a.ExecutionID = "old-execution" },
		"turn":              func(a *runsmodels.PoolExecutionActivity) { a.TurnID = "old-turn" },
		"generation":        func(a *runsmodels.PoolExecutionActivity) { a.PromptGeneration++ },
		"agent-type":        func(a *runsmodels.PoolExecutionActivity) { a.AgentType = "claude-acp" },
		"missing-operation": func(a *runsmodels.PoolExecutionActivity) { a.OperationID = "" },
		"work-source":       func(a *runsmodels.PoolExecutionActivity) { a.StartedSource = runsmodels.PoolStartAssistant },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f, identity, activity := poolActivityFixture(t, "codex-app-server")
			activity.StartedSource = ""
			change(&activity)
			event, _ := poolTurnEndRecorderFor(t, f.svc).ObservePoolTurnEnd(context.Background(), activity, false)
			require.Nil(t, event)
			events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 20)
			require.NoError(t, err)
			require.Len(t, events, 2, "拒绝的终结不能留下半次绑定或改写原分配")
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-002.4
func TestPoolTurnEndConflictsCannotRewriteOutcomeOrOperation(t *testing.T) {
	f, identity, activity := poolActivityFixture(t, "codex-app-server")
	recorder := poolTurnEndRecorderFor(t, f.svc)
	activity.StartedSource = ""
	ctx := context.Background()
	first, err := recorder.ObservePoolTurnEnd(ctx, activity, true)
	require.NoError(t, err)
	conflict, err := recorder.ObservePoolTurnEnd(ctx, activity, false)
	require.Error(t, err)
	require.Nil(t, conflict, "相反结果不是幂等重放")
	activity.OperationID = "replacement-operation"
	conflict, err = recorder.ObservePoolTurnEnd(ctx, activity, true)
	require.Error(t, err)
	require.Nil(t, conflict)
	activity.StartedSource = runsmodels.PoolStartTool
	conflict, err = f.svc.ObservePoolActivity(ctx, activity)
	require.Error(t, err)
	require.Nil(t, conflict, "更晚工作帧仍必须匹配结束事件绑定的提供商 operation")
	events, err := f.runs.ListRunEvents(ctx, identity.RunID, -1, 20)
	require.NoError(t, err)
	require.Len(t, events, 4)
	require.Equal(t, first, events[3])
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolTurnEndCommitFailureRollsBackBindingWithoutLosingClaim(t *testing.T) {
	f, identity, activity := poolActivityFixture(t, "claude-acp")
	activity.StartedSource = ""
	mustPoolAllocationExec(t, f, `CREATE TABLE pool_end_commit_guard (id TEXT PRIMARY KEY, run_id TEXT,
		FOREIGN KEY (run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED)`)
	mustPoolAllocationExec(t, f, `CREATE TRIGGER fail_pool_end_commit AFTER INSERT ON run_events
		WHEN NEW.event_type = 'pool.turn-ended.v1' BEGIN
		INSERT INTO pool_end_commit_guard (id, run_id) VALUES ('bad', 'nonexistent-run'); END`)
	event, err := poolTurnEndRecorderFor(t, f.svc).ObservePoolTurnEnd(context.Background(), activity, false)
	require.Error(t, err)
	require.Nil(t, event, "提交失败不能返回有效回合结束证据")
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 20)
	require.NoError(t, err)
	require.Len(t, events, 2)
	claim, err := f.runs.ResolveCurrentPoolClaim(context.Background(), identity.RunID)
	require.NoError(t, err)
	require.Equal(t, identity.ClaimID, claim.ClaimID)
}
