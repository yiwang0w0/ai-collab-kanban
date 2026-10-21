package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/stretchr/testify/require"
)

func recoveryRetryCommand(t *testing.T, f poolPublishFixture, identity runsmodels.PoolExecutionIdentity) runsmodels.PoolRecoveryCommand {
	t.Helper()
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
	return runsmodels.PoolRecoveryCommand{Action: "retry", OperationID: uuid.NewString(), RunID: identity.RunID,
		ExpectedClaimID: identity.ClaimID, ExpectedTaskVersion: task.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ExpectedRunVersion: runsmodels.PoolRecoveryRunVersion(run, last), Confirm: true, ConfirmCLIQuota: true}
}

// @covers AC-TASKS-AGENT-POOL-005.2 AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryRetryQueuesSameRunAndReplayCannotRequeueReplacementClaim(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
	require.NoError(t, err)
	command := recoveryRetryCommand(t, f, identity)
	before, err := f.tasks.GetTask(context.Background(), identity.TaskID)
	require.NoError(t, err)
	event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, command)
	require.NoError(t, err)
	require.NotNil(t, event)
	require.Equal(t, runsmodels.RunEventType("pool.recovery-requeued.v1"), event.EventType)
	run, err := f.runs.GetRunByID(context.Background(), identity.RunID)
	require.NoError(t, err)
	require.Equal(t, runsmodels.RunStatusQueued, run.Status)
	require.Empty(t, run.SessionID)
	require.Nil(t, run.ClaimedAt)
	require.Nil(t, run.FinishedAt)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(context.Background())
	require.NoError(t, err)
	require.NotNil(t, claim)
	require.Equal(t, identity.RunID, claim.ID)
	require.NotEqual(t, identity.ClaimID, claim.ClaimID)
	request, err := claim.PoolStartRequest()
	require.NoError(t, err)
	require.NoError(t, f.svc.AdmitPoolClaimStart(context.Background(), request))
	replayed, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, command)
	require.NoError(t, err)
	require.Equal(t, event, replayed)
	run, err = f.runs.GetRunByID(context.Background(), identity.RunID)
	require.NoError(t, err)
	require.Equal(t, runsmodels.RunStatusClaimed, run.Status)
	after, err := f.tasks.GetTask(context.Background(), identity.TaskID)
	require.NoError(t, err)
	require.Equal(t, before, after, "人工重试不能移动主卡或绕过 Done")
}

func TestPoolRecoveryRetryPreservesOldEvidenceAndProjectsFreshQueuedRound(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
	require.NoError(t, err)
	event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, recoveryRetryCommand(t, f, identity))
	require.NoError(t, err)
	snapshot, err := f.tasks.ReadPoolHistorySnapshot(context.Background(), identity.TaskID, f.task.WorkspaceID, poolhistory.Query{Limit: 50})
	require.NoError(t, err)
	page, err := poolhistory.Project(snapshot)
	require.NoError(t, err)
	require.Len(t, page.Items, 2, "旧领取仍在，当前排队另有一个无领取记录")
	var queued, ended *poolhistory.Item
	for index := range page.Items {
		item := &page.Items[index]
		if item.ClaimID == "" {
			queued = item
		} else {
			ended = item
		}
	}
	require.NotNil(t, queued)
	require.NotNil(t, ended)
	require.Equal(t, "queued", queued.State)
	require.True(t, queued.Current)
	require.True(t, event.CreatedAt.Equal(*queued.QueuedAt))
	require.Nil(t, queued.StartedAt)
	require.Equal(t, "ended", ended.State)
	require.NotNil(t, ended.StoppedAt)
	require.NotNil(t, ended.EndedAt)
	require.False(t, ended.Current)
}

func TestPoolRecoveryRetryContextVerifiesNativeStopAndRuntimeWithoutWriting(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
	require.NoError(t, err)
	before, err := f.runs.GetRunByID(context.Background(), identity.RunID)
	require.NoError(t, err)
	state, err := f.svc.GetPoolRecoveryContext(poolRecoveryHuman(), identity.TaskID, identity.RunID)
	require.NoError(t, err)
	require.True(t, state.Actions.Retry)
	require.False(t, state.Actions.Stop)
	after, err := f.runs.GetRunByID(context.Background(), identity.RunID)
	require.NoError(t, err)
	require.Equal(t, before, after, "GET 不能终结运行或入队")
}

func TestPoolRecoveryRetryNativeClaimRejectsMissingRequeueCause(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
	require.NoError(t, err)
	event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, recoveryRetryCommand(t, f, identity))
	require.NoError(t, err)
	mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE run_id=? AND seq=?`, identity.RunID, event.Seq)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(context.Background())
	require.NoError(t, err)
	require.NotNil(t, claim)
	request, err := claim.PoolStartRequest()
	require.NoError(t, err)
	require.Error(t, f.svc.AdmitPoolClaimStart(context.Background(), request), "没有人工重试凭证不能再次唤醒 CLI")
}

func TestPoolRecoveryRetryKeepsNativeInProgressTaskAndAdmitsOnlyVerifiedNextClaim(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	mustPoolAllocationExec(t, f, `UPDATE tasks SET state='IN_PROGRESS' WHERE id=?`, identity.TaskID)
	_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
	require.NoError(t, err)
	state, err := f.svc.GetPoolRecoveryContext(poolRecoveryHuman(), identity.TaskID, identity.RunID)
	require.NoError(t, err)
	require.True(t, state.Actions.Retry, "原生停止不能假装把主卡改回 TODO，已核实的同 run 重试仍须可用")
	_, err = f.svc.RecoverPoolRun(poolRecoveryHuman(), identity.TaskID, recoveryRetryCommand(t, f, identity))
	require.NoError(t, err)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(context.Background())
	require.NoError(t, err)
	require.NotNil(t, claim)
	request, err := claim.PoolStartRequest()
	require.NoError(t, err)
	require.NoError(t, f.svc.AdmitPoolClaimStart(context.Background(), request))
	after, err := f.tasks.GetTask(context.Background(), identity.TaskID)
	require.NoError(t, err)
	require.Equal(t, "IN_PROGRESS", string(after.State))
}

func TestPoolRecoveryRetryExceptionDoesNotAdmitInitialInProgressClaim(t *testing.T) {
	f, claim := claimedPoolFixture(t)
	mustPoolAllocationExec(t, f, `UPDATE tasks SET state='IN_PROGRESS' WHERE id=?`, f.task.ID)
	require.Error(t, f.svc.AdmitPoolClaimStart(context.Background(), poolClaimRequest(t, claim)))
}
