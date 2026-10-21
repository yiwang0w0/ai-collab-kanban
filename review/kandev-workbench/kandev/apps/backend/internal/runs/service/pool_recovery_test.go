package service_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kandev/kandev/internal/auth/authn"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

func poolRecoveryHuman() context.Context {
	return authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-human", SessionID: "browser-session", Role: authn.RoleAdmin})
}

func poolWithdrawal(t *testing.T, f poolPublishFixture) (runsmodels.PoolRecoveryCommand, *runsmodels.Run) {
	t.Helper()
	_, run, err := f.publisher.QueuePoolRunAndReturn(context.Background(), f.task.ID, f.release.EntryID)
	require.NoError(t, err)
	events, err := f.runs.ListRunEvents(context.Background(), run.ID, -1, 50)
	require.NoError(t, err)
	last := -1
	for _, event := range events {
		last = max(last, event.Seq)
	}
	return runsmodels.PoolRecoveryCommand{Action: "withdraw", OperationID: uuid.NewString(), RunID: run.ID,
		ExpectedTaskVersion: f.task.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ExpectedRunVersion:  runsmodels.PoolRecoveryRunVersion(run, last), Confirm: true}, run
}

// @covers AC-TASKS-AGENT-POOL-005.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryWithdrawalNativeReceipt(t *testing.T) {
	f := newPoolPublishFixture(t)
	command, before := poolWithdrawal(t, f)
	event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.NoError(t, err)
	require.NotNil(t, event)
	require.Equal(t, runsmodels.PoolRecoveryWithdrawn, string(event.EventType))
	var receipt runsmodels.PoolRecoveryOperation
	require.NoError(t, json.Unmarshal([]byte(event.Payload), &receipt))
	require.Equal(t, command, receipt.Command)
	require.Equal(t, "pool-human", receipt.ActorID)
	require.Equal(t, f.task.ID, receipt.TaskID)
	require.Equal(t, "withdrawn", receipt.Result)
	after, err := f.runs.GetRunByID(context.Background(), before.ID)
	require.NoError(t, err)
	require.Equal(t, "cancelled", string(after.Status))
	require.Equal(t, before.ID, after.ID)
	require.Equal(t, before.Payload, after.Payload)
	require.Equal(t, before.IdempotencyKey, after.IdempotencyKey)
	require.Nil(t, after.ClaimedAt)
	require.Equal(t, event.CreatedAt, *after.FinishedAt)
	currentTask, err := f.tasks.GetTask(context.Background(), f.task.ID)
	require.NoError(t, err)
	require.Equal(t, f.task.UpdatedAt, currentTask.UpdatedAt, "撤回不是主卡 Done 或阶段移动")
	replayed, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.NoError(t, err)
	require.Equal(t, event, replayed, "响应丢失后应读取同一操作，不重新取消或重派")
}
