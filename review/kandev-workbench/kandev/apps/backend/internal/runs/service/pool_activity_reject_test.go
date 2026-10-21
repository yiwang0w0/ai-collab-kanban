package service_test

import (
	"context"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolActivityCannotAdoptAnotherExecutionOrUntrustedOperation(t *testing.T) {
	changes := map[string]func(*runsmodels.PoolExecutionActivity){
		"task":                       func(a *runsmodels.PoolExecutionActivity) { a.TaskID = "other-task" },
		"profile":                    func(a *runsmodels.PoolExecutionActivity) { a.AgentProfileID = "other-profile" },
		"session":                    func(a *runsmodels.PoolExecutionActivity) { a.SessionID = "old-session" },
		"execution":                  func(a *runsmodels.PoolExecutionActivity) { a.ExecutionID = "old-execution" },
		"turn":                       func(a *runsmodels.PoolExecutionActivity) { a.TurnID = "old-turn" },
		"generation":                 func(a *runsmodels.PoolExecutionActivity) { a.PromptGeneration++ },
		"agent-type":                 func(a *runsmodels.PoolExecutionActivity) { a.AgentType = "claude-acp" },
		"missing-provider-operation": func(a *runsmodels.PoolExecutionActivity) { a.OperationID = "" },
		"unsupported-source":         func(a *runsmodels.PoolExecutionActivity) { a.StartedSource = "turn_started" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f, identity, activity := poolActivityFixture(t, "codex-app-server")
			change(&activity)
			event, _ := f.svc.ObservePoolActivity(context.Background(), activity)
			require.Nil(t, event, "不匹配的活动不能被当作当前开工")
			events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 20)
			require.NoError(t, err)
			require.Len(t, events, 2, "只能保留原意图与分配，不写绑定或工作")
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolActivityAmbiguousAllocationAndFailedWritesStayUnconfirmed(t *testing.T) {
	for _, kind := range []string{"missing", "ambiguous", "write-failure", "invented-acp-operation"} {
		t.Run(kind, func(t *testing.T) {
			f, identity, activity := poolActivityFixture(t, "claude-acp")
			switch kind {
			case "missing":
				mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE event_type = 'pool.execution-allocated.v1'`)
			case "ambiguous":
				mustPoolAllocationExec(t, f, `INSERT INTO run_events (run_id, seq, event_type, level, payload, created_at)
					SELECT run_id, seq + 10, event_type, level, payload, created_at FROM run_events WHERE event_type = 'pool.execution-allocated.v1'`)
			case "write-failure":
				mustPoolAllocationExec(t, f, `CREATE TRIGGER reject_pool_work BEFORE INSERT ON run_events
					WHEN NEW.event_type = 'pool.work-observed.v1' BEGIN SELECT RAISE(ABORT, 'work-write-failure'); END`)
			case "invented-acp-operation":
				activity.OperationID = "invented-provider-operation"
			}
			event, err := f.svc.ObservePoolActivity(context.Background(), activity)
			require.Error(t, err)
			require.Nil(t, event)
			var work int
			require.NoError(t, f.runs.Reader().Get(&work, `SELECT COUNT(*) FROM run_events WHERE run_id = ?
				AND event_type IN ('pool.execution-bound.v1', 'pool.work-observed.v1')`, identity.RunID))
			require.Zero(t, work, "事件写入失败时绑定也要回滚，不能留下半次工作证据")
			current, err := f.runs.ResolveCurrentPoolClaim(context.Background(), identity.RunID)
			require.NoError(t, err)
			require.Equal(t, identity.ClaimID, current.ClaimID)
			require.Equal(t, identity.SessionID, current.SessionID)
		})
	}
}
