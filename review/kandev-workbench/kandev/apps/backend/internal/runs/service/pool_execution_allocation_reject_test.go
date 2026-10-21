package service_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
)

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolExecutionAllocationRejectsUnprovenNativeScope(t *testing.T) {
	cases := []struct {
		name   string
		change func(*testing.T, poolPublishFixture, *runsmodels.PoolClaimStart, *runsmodels.PoolExecutionIdentity)
	}{
		{"session", func(_ *testing.T, _ poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			i.SessionID = "unallocated-session"
		}},
		{"turn", func(_ *testing.T, _ poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			i.TurnID = "unallocated-turn"
		}},
		{"generation", func(_ *testing.T, _ poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			i.PromptGeneration = 2
		}},
		{"operation", func(_ *testing.T, _ poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			i.OperationID = "invented-provider-operation"
		}},
		{"claim", func(_ *testing.T, _ poolPublishFixture, r *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			r.ClaimID = "old-claim"
			i.ClaimID = r.ClaimID
		}},
		{"execution-profile", func(_ *testing.T, _ poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			i.ExecutionProfileID = "different-profile"
		}},
		{"missing-intent", func(t *testing.T, f poolPublishFixture, r *runsmodels.PoolClaimStart, _ *runsmodels.PoolExecutionIdentity) {
			mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE run_id = ?`, r.RunID)
		}},
		{"completed-turn", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			mustPoolAllocationExec(t, f, `UPDATE task_session_turns SET completed_at = ? WHERE id = ?`, time.Now().UTC(), i.TurnID)
		}},
		{"different-native-execution", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			mustPoolAllocationExec(t, f, `UPDATE executors_running SET agent_execution_id = 'another-execution' WHERE session_id = ?`, i.SessionID)
		}},
		{"missing-native-execution", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			mustPoolAllocationExec(t, f, `DELETE FROM executors_running WHERE session_id = ?`, i.SessionID)
		}},
		{"api-profile", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			mustPoolAllocationExec(t, f, `UPDATE agent_profiles SET provider_kind = 'direct' WHERE id = ?`, i.AgentProfileID)
		}},
		{"other-active-session", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			if err := f.tasks.CreateTaskSession(context.Background(), &taskmodels.TaskSession{ID: "other-active", TaskID: i.TaskID,
				AgentProfileID: i.AgentProfileID, State: taskmodels.TaskSessionStateRunning}); err != nil {
				t.Fatal(err)
			}
		}},
		{"other-open-turn", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart, i *runsmodels.PoolExecutionIdentity) {
			if err := f.tasks.CreateTurn(context.Background(), &taskmodels.Turn{ID: "other-open-turn", TaskSessionID: i.SessionID, TaskID: i.TaskID}); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			f, request, identity := allocatedPoolFixture(t)
			item.change(t, f, &request, &identity)
			before, err := f.runs.GetRunByID(context.Background(), request.RunID)
			if err != nil {
				t.Fatal(err)
			}
			event, err := f.svc.BindPoolExecution(context.Background(), request, identity)
			if err == nil || event != nil {
				t.Fatalf("未知或错误原生身份不得绑定执行: %+v %v", event, err)
			}
			after, err := f.runs.GetRunByID(context.Background(), request.RunID)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("拒绝不能改变原生运行: %+v %v", after, err)
			}
			var count int
			if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM run_events WHERE run_id = ? AND event_type = 'pool.execution-allocated.v1'`, request.RunID); err != nil || count != 0 {
				t.Fatalf("拒绝不能留下分配记录: count=%d err=%v", count, err)
			}
		})
	}
}

func mustPoolAllocationExec(t *testing.T, f poolPublishFixture, query string, args ...any) {
	t.Helper()
	if _, err := f.runs.Writer().Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionAllocationWriteFailureRollsBackSessionBinding(t *testing.T) {
	f, request, identity := allocatedPoolFixture(t)
	ctx := context.Background()
	mustPoolAllocationExec(t, f, `CREATE TRIGGER reject_pool_allocation BEFORE INSERT ON run_events
		WHEN NEW.event_type = 'pool.execution-allocated.v1' BEGIN SELECT RAISE(ABORT, 'allocation-write-failure'); END`)
	if event, err := f.svc.BindPoolExecution(ctx, request, identity); err == nil || event != nil {
		t.Fatalf("事件持久化失败必须拒绝整个分配: %+v %v", event, err)
	}
	current, err := f.runs.ResolveCurrentPoolClaim(ctx, request.RunID)
	if err != nil || current.ClaimID != request.ClaimID || current.SessionID != "" {
		t.Fatalf("不能留下只有会话列而无事件的半次绑定: %+v %v", current, err)
	}
	mustPoolAllocationExec(t, f, `DROP TRIGGER reject_pool_allocation`)
	// 这里只重试纯数据库事务；没有启动执行器或重新调用模型。
	if event, err := f.svc.BindPoolExecution(ctx, request, identity); err != nil || event == nil || event.Seq != 1 {
		t.Fatalf("解除纯数据库故障后应能完成首次分配持久化: %+v %v", event, err)
	}
}
