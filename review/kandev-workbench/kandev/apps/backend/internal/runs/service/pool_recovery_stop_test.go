package service_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/stretchr/testify/require"
)

type recoveryStopAdmission struct {
	*orchestrator.Service
	stops      []runsmodels.PoolExecutionIdentity
	beforeStop func(runsmodels.PoolExecutionIdentity)
}

func (a *recoveryStopAdmission) WithPoolRecoveryStop(ctx context.Context, identity runsmodels.PoolExecutionIdentity, admit func(context.Context) (bool, error)) error {
	committed, err := admit(ctx)
	if err != nil || !committed {
		return err
	}
	if a.beforeStop != nil {
		a.beforeStop(identity)
	}
	a.stops = append(a.stops, identity)
	return nil
}

func preparedRecoveryStop(t *testing.T) (poolPublishFixture, runsmodels.PoolExecutionIdentity, runsmodels.PoolRecoveryCommand, *recoveryStopAdmission) {
	t.Helper()
	f, request, identity := allocatedPoolFixture(t)
	_, err := f.svc.BindPoolExecution(context.Background(), request, identity)
	require.NoError(t, err)
	admission := &recoveryStopAdmission{Service: &orchestrator.Service{}}
	f.svc.SetPoolEnqueueAdmission(admission)
	run, err := f.runs.GetRunByID(context.Background(), identity.RunID)
	require.NoError(t, err)
	task, err := f.tasks.GetTask(context.Background(), identity.TaskID)
	require.NoError(t, err)
	events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 50)
	require.NoError(t, err)
	last := -1
	for _, event := range events {
		last = max(last, event.Seq)
	}
	command := runsmodels.PoolRecoveryCommand{Action: "stop", OperationID: uuid.NewString(), RunID: run.ID,
		ExpectedClaimID: identity.ClaimID, ExpectedTaskVersion: task.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ExpectedRunVersion: runsmodels.PoolRecoveryRunVersion(run, last), Confirm: true}
	return f, identity, command, admission
}

// @covers AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryStopCommitsExactIntentBeforeIOAndReplaysWithoutStoppingAgain(t *testing.T) {
	f, identity, command, admission := preparedRecoveryStop(t)
	admission.beforeStop = func(actual runsmodels.PoolExecutionIdentity) {
		require.Equal(t, identity, actual)
		events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 50)
		require.NoError(t, err)
		require.Len(t, events, 3, "外部停止前必须已持久化本操作意图")
		require.Equal(t, "pool.recovery-stop-requested.v1", string(events[2].EventType))
	}
	event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, command)
	require.NoError(t, err)
	require.NotNil(t, event)
	var payload struct {
		runsmodels.PoolRecoveryOperation
		Execution runsmodels.PoolExecutionIdentity `json:"execution"`
	}
	require.NoError(t, json.Unmarshal([]byte(event.Payload), &payload))
	require.Equal(t, command, payload.Command)
	require.Equal(t, "stop_requested", payload.Result)
	require.Equal(t, identity, payload.Execution)
	run, err := f.runs.GetRunByID(context.Background(), identity.RunID)
	require.NoError(t, err)
	require.Equal(t, runsmodels.RunStatusClaimed, run.Status)
	require.Nil(t, run.FinishedAt, "停止请求回执不等于物理停止或运行终结")
	replayed, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, command)
	require.NoError(t, err)
	require.Equal(t, event, replayed)
	require.Equal(t, []runsmodels.PoolExecutionIdentity{identity}, admission.stops)
	queried, err := f.svc.GetPoolRecoveryOperation(poolRecoveryHuman(), identity.TaskID, identity.RunID, command.OperationID)
	require.NoError(t, err)
	require.Equal(t, event, queried)
}

func TestPoolRecoveryStopRejectsChangedClaimVersionOrNativeExecutionBeforeIntent(t *testing.T) {
	for _, mode := range []string{"claim", "run-version", "native-execution"} {
		t.Run(mode, func(t *testing.T) {
			f, identity, command, admission := preparedRecoveryStop(t)
			switch mode {
			case "claim":
				command.ExpectedClaimID = "old-claim"
			case "run-version":
				command.ExpectedRunVersion = strings.Repeat("0", 64)
			case "native-execution":
				_, err := f.runs.Writer().Exec(`UPDATE executors_running SET agent_execution_id='replacement' WHERE session_id=?`, identity.SessionID)
				require.NoError(t, err)
			}
			event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, command)
			require.Error(t, err)
			require.Nil(t, event)
			require.Empty(t, admission.stops)
			events, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 50)
			require.NoError(t, err)
			require.Len(t, events, 2)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-005.3
func TestPoolRecoveryStopRequestPreservesObservedWorkInNativeProjection(t *testing.T) {
	f, identity, command, _ := preparedRecoveryStop(t)
	ctx := context.Background()
	activity := runsmodels.PoolExecutionActivity{TaskID: identity.TaskID, AgentProfileID: identity.AgentProfileID,
		SessionID: identity.SessionID, ExecutionID: identity.ExecutionID, TurnID: identity.TurnID,
		PromptGeneration: 1, AgentType: "claude-acp", StartedSource: runsmodels.PoolStartAssistant}
	work, err := f.svc.ObservePoolActivity(ctx, activity)
	require.NoError(t, err)
	require.NotNil(t, work)
	run, err := f.runs.GetRunByID(ctx, identity.RunID)
	require.NoError(t, err)
	command.ExpectedRunVersion = runsmodels.PoolRecoveryRunVersion(run, work.Seq)
	_, err = f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, command)
	require.NoError(t, err)
	snapshot, err := f.tasks.ReadPoolHistorySnapshot(ctx, identity.TaskID, f.task.WorkspaceID, poolhistory.Query{Limit: 50})
	require.NoError(t, err)
	page, err := poolhistory.Project(snapshot)
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	require.Equal(t, "started", page.Items[0].State, "停止请求不能抹掉真实开工，也不等于已停止")
	require.NotNil(t, page.Items[0].StartedAt)
	require.True(t, work.CreatedAt.Equal(*page.Items[0].StartedAt))
	require.Nil(t, page.Items[0].StoppedAt)
}
