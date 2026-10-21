package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type stoppedPoolRunFinalizer interface {
	FinalizeStoppedPoolRun(context.Context, runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error)
}

// 事务测试使用显式资源能力替身；原生运行时、LSP 和生命周期锁另有真实边界测试。
type poolFinishAdmission struct {
	*orchestrator.Service
	resourceError error
}

func (a *poolFinishAdmission) WithPoolExecutionQuiescence(ctx context.Context, identity runsmodels.PoolExecutionIdentity, fn func(context.Context) error) error {
	return a.WithPoolEnqueueAdmission(ctx, identity.TaskID, func(admitted context.Context, preparing bool) error {
		if preparing {
			return runsmodels.ErrPoolTaskStartPreparing
		}
		if a.resourceError != nil {
			return a.resourceError
		}
		return fn(admitted)
	})
}

func poolFinishFixture(t *testing.T) (poolPublishFixture, runsmodels.PoolExecutionIdentity, stoppedPoolRunFinalizer) {
	t.Helper()
	f, identity := poolQuiescentDatabaseFixture(t)
	f.svc.SetPoolEnqueueAdmission(&poolFinishAdmission{Service: &orchestrator.Service{}})
	finalizer, supported := any(f.svc).(stoppedPoolRunFinalizer)
	require.True(t, supported, "运行服务缺少核对当前领取与完整停止证据的专用终结入口")
	return f, identity, finalizer
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionFinishCommitsReceiptAndRunWithoutCompletingTask(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	ctx := context.Background()
	before, err := f.tasks.GetTask(ctx, identity.TaskID)
	require.NoError(t, err)
	event, err := finalizer.FinalizeStoppedPoolRun(ctx, identity)
	require.NoError(t, err)
	require.NotNil(t, event)
	require.Equal(t, runsmodels.RunEventType("pool.execution-finished.v1"), event.EventType)
	var receipt struct {
		runsmodels.PoolExecutionIdentity
		StoppedSeq int `json:"stopped_seq"`
	}
	require.NoError(t, json.Unmarshal([]byte(event.Payload), &receipt))
	require.Equal(t, identity, receipt.PoolExecutionIdentity)
	require.Equal(t, 2, receipt.StoppedSeq)
	run, err := f.runs.GetRunByID(ctx, identity.RunID)
	require.NoError(t, err)
	require.Equal(t, runsmodels.RunStatusFinished, run.Status)
	require.NotNil(t, run.FinishedAt)
	require.Equal(t, event.CreatedAt, *run.FinishedAt)
	require.NotNil(t, run.Outcome)
	require.Equal(t, "pool_execution_stopped", *run.Outcome)
	replayed, err := finalizer.FinalizeStoppedPoolRun(ctx, identity)
	require.NoError(t, err)
	require.Equal(t, event, replayed, "响应丢失重放不能重写时间或追加终结")
	after, err := f.tasks.GetTask(ctx, identity.TaskID)
	require.NoError(t, err)
	require.Equal(t, before, after, "运行终结不能移动主卡、清 checkout 或签发 Done")
	events, err := f.runs.ListRunEvents(ctx, identity.RunID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 4, "不能凭停止补造开工或回合结果")
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionFinishRejectsUnknownProofAndOwnership(t *testing.T) {
	for _, mode := range []string{"no-stop", "activity-not-released", "foreign-stop", "duplicate-stop", "no-intent", "no-allocation", "wrong-claim", "wrong-execution", "wrong-operation", "foreign-checkout", "live-turn", "wrong-session", "runtime-busy", "no-runtime-capability", "no-source"} {
		t.Run(mode, func(t *testing.T) {
			f, identity, finalizer := poolFinishFixture(t)
			switch mode {
			case "no-stop":
				mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE event_type='pool.execution-stopped.v1'`)
			case "activity-not-released":
				mustPoolAllocationExec(t, f, `UPDATE run_events SET payload=json_set(payload,'$.execution_activity_released',json('false')) WHERE event_type='pool.execution-stopped.v1'`)
			case "foreign-stop":
				mustPoolAllocationExec(t, f, `UPDATE run_events SET payload=json_set(payload,'$.execution_id','other-execution') WHERE event_type='pool.execution-stopped.v1'`)
			case "duplicate-stop":
				mustPoolAllocationExec(t, f, `INSERT INTO run_events SELECT run_id,99,event_type,level,payload,created_at FROM run_events WHERE event_type='pool.execution-stopped.v1'`)
			case "no-intent":
				mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE event_type='pool.launch-admitted.v1'`)
			case "no-allocation":
				mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE event_type='pool.execution-allocated.v1'`)
			case "wrong-claim":
				identity.ClaimID = "old-claim"
			case "wrong-execution":
				identity.ExecutionID = "old-execution"
			case "wrong-operation":
				identity.OperationID = "invented-provider-operation"
			case "foreign-checkout":
				mustPoolAllocationExec(t, f, `UPDATE tasks SET checkout_agent_id='other-owner' WHERE id=?`, identity.TaskID)
			case "live-turn":
				mustPoolAllocationExec(t, f, `UPDATE task_session_turns SET completed_at=NULL WHERE id=?`, identity.TurnID)
			case "wrong-session":
				mustPoolAllocationExec(t, f, `UPDATE runs SET session_id='replacement-session' WHERE id=?`, identity.RunID)
			case "runtime-busy":
				f.svc.SetPoolEnqueueAdmission(&poolFinishAdmission{Service: &orchestrator.Service{}, resourceError: errors.New("native-resources-busy")})
			case "no-runtime-capability":
				f.svc.SetPoolEnqueueAdmission(&orchestrator.Service{})
			case "no-source":
				f.svc.SetPoolReleaseSource(nil)
			}
			event, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
			require.Error(t, err)
			require.Nil(t, event)
			run, err := f.runs.GetRunByID(context.Background(), identity.RunID)
			require.NoError(t, err)
			require.Equal(t, runsmodels.RunStatusClaimed, run.Status)
			require.Nil(t, run.FinishedAt)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionFinishCommitFailureKeepsClaimAndNoReceipt(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	mustPoolAllocationExec(t, f, `CREATE TABLE pool_finish_commit_guard (id TEXT PRIMARY KEY, run_id TEXT,
		FOREIGN KEY (run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED)`)
	mustPoolAllocationExec(t, f, `CREATE TRIGGER fail_pool_finish_commit AFTER INSERT ON run_events
		WHEN NEW.event_type='pool.execution-finished.v1' BEGIN
		INSERT INTO pool_finish_commit_guard (id,run_id) VALUES ('bad','nonexistent-run'); END`)
	event, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
	require.Error(t, err)
	require.Nil(t, event, "不能返回未提交的成功回执")
	claim, err := f.runs.ResolveCurrentPoolClaim(context.Background(), identity.RunID)
	require.NoError(t, err)
	require.Equal(t, identity.ClaimID, claim.ClaimID)
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 3)
}

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolExecutionFinishConcurrentReplayKeepsOneTerminal(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	const count = 8
	start := make(chan struct{})
	type result struct {
		event *runsmodels.RunEvent
		err   error
	}
	results := make(chan result, count)
	var joined sync.WaitGroup
	for range count {
		joined.Add(1)
		go func() {
			defer joined.Done()
			<-start
			event, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
			results <- result{event: event, err: err}
		}()
	}
	close(start)
	joined.Wait()
	close(results)
	var first *runsmodels.RunEvent
	for result := range results {
		require.NoError(t, result.err)
		require.NotNil(t, result.event)
		if first == nil {
			first = result.event
		}
		require.Equal(t, first, result.event)
	}
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 10)
	require.NoError(t, err)
	require.Len(t, events, 4)
}
