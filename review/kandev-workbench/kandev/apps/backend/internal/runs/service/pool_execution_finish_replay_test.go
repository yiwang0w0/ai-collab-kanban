package service_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionFinishReplayCannotAcceptStaleLedgerOrContradictoryTerminal(t *testing.T) {
	for _, mode := range []string{"new-claim", "missing-ledger", "ambiguous-ledger", "claimed-again", "missing-finished-at", "wrong-outcome", "wrong-terminal", "foreign-receipt", "duplicate-receipt"} {
		t.Run(mode, func(t *testing.T) {
			f, identity, finalizer := poolFinishFixture(t)
			ctx := context.Background()
			_, err := finalizer.FinalizeStoppedPoolRun(ctx, identity)
			require.NoError(t, err)
			switch mode {
			case "new-claim":
				mustPoolAllocationExec(t, f, `UPDATE office_launch_ledger SET id='replacement-claim' WHERE id=?`, identity.ClaimID)
			case "missing-ledger":
				mustPoolAllocationExec(t, f, `DELETE FROM office_launch_ledger WHERE id=?`, identity.ClaimID)
			case "ambiguous-ledger":
				mustPoolAllocationExec(t, f, `INSERT INTO office_launch_ledger (id,run_id,workspace_id,claimed_at)
					SELECT 'ambiguous-claim',run_id,workspace_id,claimed_at FROM office_launch_ledger WHERE id=?`, identity.ClaimID)
			case "claimed-again":
				mustPoolAllocationExec(t, f, `UPDATE runs SET status='claimed',finished_at=NULL WHERE id=?`, identity.RunID)
			case "missing-finished-at":
				mustPoolAllocationExec(t, f, `UPDATE runs SET finished_at=NULL WHERE id=?`, identity.RunID)
			case "wrong-outcome":
				mustPoolAllocationExec(t, f, `UPDATE runs SET outcome='completed' WHERE id=?`, identity.RunID)
			case "wrong-terminal":
				mustPoolAllocationExec(t, f, `UPDATE runs SET status='failed' WHERE id=?`, identity.RunID)
			case "foreign-receipt":
				mustPoolAllocationExec(t, f, `UPDATE run_events SET payload=json_set(payload,'$.execution_id','other-execution') WHERE event_type='pool.execution-finished.v1'`)
			case "duplicate-receipt":
				mustPoolAllocationExec(t, f, `INSERT INTO run_events SELECT run_id,99,event_type,level,payload,created_at FROM run_events WHERE event_type='pool.execution-finished.v1'`)
			}
			before, err := f.runs.GetRunByID(ctx, identity.RunID)
			require.NoError(t, err)
			event, err := finalizer.FinalizeStoppedPoolRun(ctx, identity)
			require.Error(t, err)
			require.Nil(t, event, "历史回执存在也不能绕过当前账本和运行矛盾")
			after, err := f.runs.GetRunByID(ctx, identity.RunID)
			require.NoError(t, err)
			require.Equal(t, before, after)
		})
	}
}
