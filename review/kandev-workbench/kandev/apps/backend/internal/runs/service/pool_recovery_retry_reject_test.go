package service_test

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

func invalidateRetryFixture(t *testing.T, f poolPublishFixture, identity runsmodels.PoolExecutionIdentity, mode string) {
	t.Helper()
	switch mode {
	case "no-stop":
		mustPoolAllocationExec(t, f, `DELETE FROM run_events WHERE run_id=? AND event_type='pool.execution-stopped.v1'`, identity.RunID)
	case "activity-held":
		mustPoolAllocationExec(t, f, `UPDATE run_events SET payload=json_set(payload,'$.execution_activity_released',json('false')) WHERE run_id=? AND event_type='pool.execution-stopped.v1'`, identity.RunID)
	case "live-turn":
		mustPoolAllocationExec(t, f, `UPDATE task_session_turns SET completed_at=NULL WHERE id=?`, identity.TurnID)
	case "checkout-held":
		mustPoolAllocationExec(t, f, `UPDATE tasks SET checkout_agent_id='other' WHERE id=?`, identity.TaskID)
	case "runtime-held":
		f.svc.SetPoolEnqueueAdmission(&poolFinishAdmission{Service: &orchestrator.Service{}, resourceError: runsmodels.ErrPoolResourcesUnconfirmed})
	case "insert-fails":
		mustPoolAllocationExec(t, f, `CREATE TRIGGER reject_retry BEFORE INSERT ON run_events WHEN NEW.event_type='pool.recovery-requeued.v1' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`)
	}
}

// @covers AC-TASKS-AGENT-POOL-005.2 AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryRetryNeverQueuesUnknownOrHeldResourcesAndRollsBackFinish(t *testing.T) {
	for _, mode := range []string{"no-stop", "activity-held", "live-turn", "checkout-held", "runtime-held", "insert-fails", "no-human", "no-quota"} {
		t.Run(mode, func(t *testing.T) {
			f, identity, _ := poolFinishFixture(t)
			invalidateRetryFixture(t, f, identity, mode)
			command := recoveryRetryCommand(t, f, identity)
			ctx := poolRecoveryHuman()
			if mode == "no-human" {
				ctx = context.Background()
			}
			if mode == "no-quota" {
				command.ConfirmCLIQuota = false
			}
			before, err := f.runs.GetRunByID(context.Background(), identity.RunID)
			require.NoError(t, err)
			eventsBefore, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 50)
			require.NoError(t, err)
			_, err = f.svc.RecoverPoolRun(ctx, identity.TaskID, command)
			require.Error(t, err)
			after, err := f.runs.GetRunByID(context.Background(), identity.RunID)
			require.NoError(t, err)
			require.Equal(t, before, after, "失败不能留下已终结或排队的中间状态")
			eventsAfter, err := f.runs.ListRunEvents(context.Background(), identity.RunID, -1, 50)
			require.NoError(t, err)
			require.Equal(t, eventsBefore, eventsAfter)
		})
	}
}

func TestPoolRecoveryRetryContextDoesNotOfferRecoveryToNonHuman(t *testing.T) {
	f, identity, finalizer := poolFinishFixture(t)
	_, err := finalizer.FinalizeStoppedPoolRun(context.Background(), identity)
	require.NoError(t, err)
	state, err := f.svc.GetPoolRecoveryContext(context.Background(), identity.TaskID, identity.RunID)
	require.NoError(t, err)
	require.False(t, state.Actions.Retry)
	require.False(t, state.Actions.Stop)
}
