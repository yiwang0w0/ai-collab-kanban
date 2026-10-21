package service_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

func poolActivityFixture(t *testing.T, agentType string) (poolPublishFixture, runsmodels.PoolExecutionIdentity, runsmodels.PoolExecutionActivity) {
	t.Helper()
	f, request, identity := allocatedPoolFixture(t)
	mustPoolAllocationExec(t, f, `UPDATE agents SET name = ? WHERE id = 'test-agent'`, agentType)
	_, err := f.svc.BindPoolExecution(context.Background(), request, identity)
	require.NoError(t, err)
	activity := runsmodels.PoolExecutionActivity{TaskID: identity.TaskID, AgentProfileID: identity.AgentProfileID,
		SessionID: identity.SessionID, ExecutionID: identity.ExecutionID, TurnID: identity.TurnID,
		PromptGeneration: 1, AgentType: agentType, StartedSource: runsmodels.PoolStartAssistant}
	if agentType == "codex-app-server" {
		activity.OperationID = "provider-operation"
	}
	return f, identity, activity
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolActivityKeepsProviderAndHostTurnOperationsDistinctAndReplaysFirstWork(t *testing.T) {
	for _, agentType := range []string{"claude-acp", "codex-acp", "codex-app-server"} {
		t.Run(agentType, func(t *testing.T) {
			f, allocated, activity := poolActivityFixture(t, agentType)
			if agentType == "codex-app-server" {
				activity.StartedSource = runsmodels.PoolStartCodexProvider
			}
			ctx := context.Background()
			first, err := f.svc.ObservePoolActivity(ctx, activity)
			require.NoError(t, err)
			require.NotNil(t, first)
			require.Equal(t, 3, first.Seq)
			var receipt runsmodels.PoolWorkReceipt
			require.NoError(t, json.Unmarshal([]byte(first.Payload), &receipt))
			require.Equal(t, allocated.RunID, receipt.RunID)
			require.Equal(t, allocated.ClaimID, receipt.ClaimID)
			if agentType == "codex-app-server" {
				require.Equal(t, runsmodels.PoolOperationProvider, receipt.OperationSource)
				require.Equal(t, activity.OperationID, receipt.OperationID)
			} else {
				require.Equal(t, runsmodels.PoolOperationHostTurn, receipt.OperationSource)
				require.Equal(t, allocated.TurnID, receipt.OperationID)
			}
			activity.StartedSource = runsmodels.PoolStartTool
			replayed, err := f.svc.ObservePoolActivity(ctx, activity)
			require.NoError(t, err)
			require.Equal(t, first, replayed, "后续工具活动不能改写首次来源或时刻")
			current, err := f.runs.GetRunByID(ctx, allocated.RunID)
			require.NoError(t, err)
			require.Equal(t, runsmodels.RunStatusClaimed, current.Status)
			require.Nil(t, current.FinishedAt, "开工不完成运行，更不完成主卡")
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolActivityConcurrentFirstFramesWriteOneBindingAndWorkReceipt(t *testing.T) {
	f, identity, activity := poolActivityFixture(t, "codex-app-server")
	const count = 12
	start := make(chan struct{})
	results := make(chan *runsmodels.RunEvent, count)
	errors := make(chan error, count)
	var wg sync.WaitGroup
	for range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			event, err := f.svc.ObservePoolActivity(context.Background(), activity)
			results <- event
			errors <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	var first *runsmodels.RunEvent
	for result := range results {
		require.NotNil(t, result)
		if first == nil {
			first = result
		}
		require.Equal(t, first, result)
	}
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 20)
	require.NoError(t, err)
	require.Len(t, events, 4)
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolActivityCommitFailureDoesNotReturnUncommittedEvidence(t *testing.T) {
	f, identity, activity := poolActivityFixture(t, "claude-acp")
	mustPoolAllocationExec(t, f, `CREATE TABLE pool_commit_guard (id TEXT PRIMARY KEY, run_id TEXT,
		FOREIGN KEY (run_id) REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED)`)
	mustPoolAllocationExec(t, f, `CREATE TRIGGER fail_pool_work_commit AFTER INSERT ON run_events
		WHEN NEW.event_type = 'pool.work-observed.v1' BEGIN
		INSERT INTO pool_commit_guard (id, run_id) VALUES ('bad', 'nonexistent-run'); END`)
	event, err := f.svc.ObservePoolActivity(context.Background(), activity)
	require.Error(t, err)
	require.Nil(t, event, "提交失败不能返回看似有效的工作证据")
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 20)
	require.NoError(t, err)
	require.Len(t, events, 2, "绑定和工作必须一起回滚；已提交的分配与意图保留")
}
