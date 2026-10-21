package service_test

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	"github.com/stretchr/testify/require"
)

func poolResumeCarrier(identity runsmodels.PoolExecutionIdentity) *taskmodels.ExecutorRunning {
	return &taskmodels.ExecutorRunning{ID: identity.SessionID, SessionID: identity.SessionID, TaskID: identity.TaskID,
		AgentExecutionID: identity.ExecutionID, ExecutionProfileID: identity.ExecutionProfileID,
		ExecutorID: taskmodels.ExecutorIDWorktree, Status: taskmodels.ExecutorRunningStatusStopped,
		Resumable: true, ResumeToken: "fixture-native-resume"}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolFinishPreservesExactNativeStoppedResumeCarrier(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	ctx := context.Background()
	require.NoError(t, f.tasks.UpsertExecutorRunning(ctx, poolResumeCarrier(identity)))
	before, err := f.tasks.GetExecutorRunningBySessionID(ctx, identity.SessionID)
	require.NoError(t, err)
	event, err := finalizer.FinalizeStoppedPoolRun(ctx, identity)
	require.NoError(t, err)
	require.NotNil(t, event)
	after, err := f.tasks.GetExecutorRunningBySessionID(ctx, identity.SessionID)
	require.NoError(t, err)
	require.Equal(t, before, after, "终结不得删除或改写原生恢复记录")
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolFinishRejectsUnreleasedOrRotatedResumeCarrier(t *testing.T) {
	cases := []struct {
		name string
		edit func(*taskmodels.ExecutorRunning)
	}{
		{"running", func(row *taskmodels.ExecutorRunning) { row.Status = taskmodels.ExecutorRunningStatusRunning }},
		{"prepared", func(row *taskmodels.ExecutorRunning) { row.Status = taskmodels.ExecutorRunningStatusPrepared }},
		{"unknown", func(row *taskmodels.ExecutorRunning) { row.Status = "unknown" }},
		{"local_pid", func(row *taskmodels.ExecutorRunning) { row.LocalPID = 12345 }},
		{"remote_pid", func(row *taskmodels.ExecutorRunning) { row.PID = 12345 }},
		{"rotated_execution", func(row *taskmodels.ExecutorRunning) { row.AgentExecutionID = "replacement" }},
		{"different_profile", func(row *taskmodels.ExecutorRunning) { row.ExecutionProfileID = "another-profile" }},
		{"different_executor", func(row *taskmodels.ExecutorRunning) { row.ExecutorID = taskmodels.ExecutorIDLocal }},
		{"different_row_identity", func(row *taskmodels.ExecutorRunning) { row.ID = "another-record" }},
		{"unknown_runtime", func(row *taskmodels.ExecutorRunning) { row.Runtime = "unrecognized" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			f, identity, finalizer := poolFinishFixture(t)
			row := poolResumeCarrier(identity)
			test.edit(row)
			require.NoError(t, f.tasks.UpsertExecutorRunning(context.Background(), row))
			_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
			require.Error(t, err)
			run, err := f.runs.GetRunByID(context.Background(), identity.RunID)
			require.NoError(t, err)
			require.Equal(t, runsmodels.RunStatusClaimed, run.Status)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolFinishResumeCarrierIsNotStopOrQuiescenceProof(t *testing.T) {
	for _, mode := range []string{"missing-stop", "activity-owned", "runtime-busy", "second-record"} {
		t.Run(mode, func(t *testing.T) {
			f, identity, finalizer := poolFinishFixture(t)
			require.NoError(t, f.tasks.UpsertExecutorRunning(context.Background(), poolResumeCarrier(identity)))
			switch mode {
			case "missing-stop":
				mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE event_type='pool.execution-stopped.v1'`)
			case "activity-owned":
				mustPoolAllocationExec(t, f, `UPDATE run_events SET payload=json_set(payload,'$.execution_activity_released',json('false')) WHERE event_type='pool.execution-stopped.v1'`)
			case "runtime-busy":
				f.svc.SetPoolEnqueueAdmission(&poolFinishAdmission{Service: &orchestrator.Service{}, resourceError: runsmodels.ErrPoolResourcesUnconfirmed})
			case "second-record":
				other := poolResumeCarrier(identity)
				other.ID, other.SessionID = "other-record", "other-session"
				require.NoError(t, f.tasks.UpsertExecutorRunning(context.Background(), other))
			}
			_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
			require.Error(t, err)
		})
	}
}
