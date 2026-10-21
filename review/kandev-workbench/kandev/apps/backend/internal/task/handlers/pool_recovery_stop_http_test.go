package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/stretchr/testify/require"
)

type wireRecoveryStopAdmission struct {
	*orchestrator.Service
	stops []runsmodels.PoolExecutionIdentity
}

func (a *wireRecoveryStopAdmission) WithPoolRecoveryStop(ctx context.Context, identity runsmodels.PoolExecutionIdentity, admit func(context.Context) (bool, error)) error {
	committed, err := admit(ctx)
	if err == nil && committed {
		a.stops = append(a.stops, identity)
	}
	return err
}

func readyPoolWireStop(t *testing.T) (poolMoveWireFixture, runsmodels.PoolRecoveryCommand, *wireRecoveryStopAdmission) {
	t.Helper()
	f, command, _ := readyPoolWireRecovery(t)
	admission := &wireRecoveryStopAdmission{Service: &orchestrator.Service{}}
	queue := runsservice.New(f.runs, nil, f.handler.logger, nil)
	queue.SetPoolReleaseSource(f.tasks)
	queue.SetPoolEnqueueAdmission(admission)
	f.service.SetPoolRunQueue(queue)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	request, err := claim.PoolStartRequest()
	require.NoError(t, err)
	require.NoError(t, queue.AdmitPoolClaimStart(f.ctx, request))
	identity := runsmodels.PoolExecutionIdentity{RunID: claim.ID, ClaimID: claim.ClaimID, TaskID: f.task.ID,
		AgentProfileID: claim.AgentProfileID, ExecutionProfileID: claim.AgentProfileID,
		SessionID: uuid.NewString(), ExecutionID: uuid.NewString(), TurnID: uuid.NewString(), PromptGeneration: 1}
	require.NoError(t, f.tasks.CreateTaskSession(f.ctx, &models.TaskSession{ID: identity.SessionID, TaskID: identity.TaskID,
		AgentProfileID: identity.AgentProfileID, ExecutionProfileID: identity.ExecutionProfileID,
		ExecutorID: models.ExecutorIDWorktree, State: models.TaskSessionStateCreated}))
	require.NoError(t, f.tasks.CreateTurn(f.ctx, &models.Turn{ID: identity.TurnID, TaskSessionID: identity.SessionID,
		TaskID: identity.TaskID, ExecutionProfileID: identity.ExecutionProfileID}))
	require.NoError(t, f.tasks.UpsertExecutorRunning(f.ctx, &models.ExecutorRunning{ID: identity.SessionID,
		SessionID: identity.SessionID, TaskID: identity.TaskID, ExecutionProfileID: identity.ExecutionProfileID,
		ExecutorID: models.ExecutorIDWorktree, AgentExecutionID: identity.ExecutionID, Status: models.ExecutorRunningStatusStarting}))
	_, err = queue.BindPoolExecution(f.ctx, request, identity)
	require.NoError(t, err)
	run, err := f.runs.GetRunByID(f.ctx, identity.RunID)
	require.NoError(t, err)
	events, err := f.runs.ListRunEvents(f.ctx, identity.RunID, -1, 50)
	require.NoError(t, err)
	last := -1
	for _, event := range events {
		last = max(last, event.Seq)
	}
	task, err := f.tasks.GetTask(f.ctx, identity.TaskID)
	require.NoError(t, err)
	command.Action, command.ExpectedClaimID = "stop", identity.ClaimID
	command.ExpectedTaskVersion = task.UpdatedAt.UTC().Format(time.RFC3339Nano)
	command.ExpectedRunVersion = runsmodels.PoolRecoveryRunVersion(run, last)
	return f, command, admission
}

// @covers AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryHTTPStopContextOffersOnlyExactCurrentStop(t *testing.T) {
	f, command, _ := readyPoolWireStop(t)
	before := poolHistorySourceCounts(t, f)
	response := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet,
		"/api/v1/tasks/"+f.task.ID+"/pool-recovery?run_id="+command.RunID, nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var state recoveryWireContext
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &state))
	require.Equal(t, command.ExpectedClaimID, state.ClaimID)
	require.False(t, state.Actions.Withdraw)
	require.True(t, state.Actions.Stop)
	require.False(t, state.Actions.Retry, "只有停止请求或没有物理停止时不能重试")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

func TestPoolRecoveryHTTPStopReceiptReplayAndQueryRemainRequestOnly(t *testing.T) {
	f, command, admission := readyPoolWireStop(t)
	base := "/api/v1/tasks/" + f.task.ID + "/pool-recovery"
	response := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, command)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), `"result":"stop_requested"`)
	require.NotContains(t, response.Body.String(), `"execution"`)
	replayed := poolRecoveryWireRequest(t, f, f.ctx, http.MethodPost, base, command)
	require.Equal(t, response.Code, replayed.Code)
	require.Equal(t, response.Body.String(), replayed.Body.String())
	query := poolRecoveryWireRequest(t, f, f.ctx, http.MethodGet, base+"/"+command.OperationID+"?run_id="+command.RunID, nil)
	require.Equal(t, response.Code, query.Code)
	require.Equal(t, response.Body.String(), query.Body.String())
	require.Len(t, admission.stops, 1)
	run, err := f.runs.GetRunByID(f.ctx, command.RunID)
	require.NoError(t, err)
	require.Equal(t, runsmodels.RunStatusClaimed, run.Status)
	require.Nil(t, run.FinishedAt)
}
