package handlers

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryReceiptBudgetCountsSelectedClaimsNotOnlyRuns(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	start, err := claim.PoolStartRequest()
	require.NoError(t, err)
	claimedAt := *claim.ClaimedAt
	for index := range 3 {
		identity := runsmodels.PoolExecutionIdentity{RunID: claim.ID, ClaimID: fmt.Sprintf("receipt-budget-%d", index),
			TaskID: f.task.ID, AgentProfileID: claim.AgentProfileID, ExecutionProfileID: "worktree-profile",
			SessionID: fmt.Sprintf("session-%d", index), ExecutionID: fmt.Sprintf("execution-%d", index), PromptGeneration: 1}
		at := claimedAt.Add(time.Duration(index) * time.Second)
		if index == 2 {
			identity.ClaimID = claim.ClaimID
			_, err = f.database.Exec(`UPDATE office_launch_ledger SET claimed_at=? WHERE id=?`, at, claim.ClaimID)
			require.NoError(t, err)
			_, err = f.database.Exec(`UPDATE runs SET claimed_at=? WHERE id=?`, at, claim.ID)
			require.NoError(t, err)
		} else {
			_, err = f.database.Exec(`INSERT INTO office_launch_ledger(id,run_id,workspace_id,claimed_at) VALUES(?,?,?,?)`,
				identity.ClaimID, claim.ID, f.task.WorkspaceID, at)
			require.NoError(t, err)
		}
		seedPoolReceiptBudgetAttempt(t, f, start.Release, identity, index*7, at)
	}
	// 只构造读源容量夹具，不声称启动、停止或人工恢复已经真实执行。
	before := poolHistorySourceCounts(t, f)
	snapshot, err := f.tasks.ReadPoolHistorySnapshot(f.ctx, f.task.ID, f.task.WorkspaceID, poolhistory.Query{Limit: 50})
	require.NoError(t, err)
	require.Len(t, snapshot.Selections, 3)
	require.Len(t, snapshot.Events, 21, "一个 run 的三个领取不能共用一份 16 事件预算")
	require.False(t, snapshot.EvidenceIncomplete)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

func seedPoolReceiptBudgetAttempt(t *testing.T, f poolMoveWireFixture, release runsmodels.PoolReleaseSnapshot,
	identity runsmodels.PoolExecutionIdentity, base int, at time.Time) {
	t.Helper()
	work := identity
	work.TurnID, work.OperationID, work.OperationSource = "turn", "operation", runsmodels.PoolOperationHostTurn
	events := []struct {
		kind    string
		payload any
	}{
		{runsmodels.PoolLaunchAdmitted, runsmodels.PoolClaimStart{RunID: identity.RunID, ClaimID: identity.ClaimID, Release: release}},
		{runsmodels.PoolExecutionAllocated, runsmodels.PoolExecutionAllocation{PoolExecutionIdentity: identity, AgentType: "claude-acp"}},
		{runsmodels.PoolExecutionBound, work},
		{runsmodels.PoolWorkObserved, runsmodels.PoolWorkReceipt{PoolExecutionIdentity: work, StartedSource: runsmodels.PoolStartAssistant}},
		{runsmodels.PoolTurnEnded, runsmodels.PoolTurnEndReceipt{PoolExecutionIdentity: work, Outcome: runsmodels.PoolTurnCompleted}},
		{runsmodels.PoolExecutionStopped, runsmodels.PoolExecutionStopReceipt{PoolExecutionIdentity: identity, Source: runsmodels.PoolStopStandaloneControl,
			RuntimeInstanceID: identity.ExecutionID, ExecutionActivityReleased: true}},
		{runsmodels.PoolExecutionFinished, runsmodels.PoolExecutionFinishReceipt{PoolExecutionIdentity: identity, StoppedSeq: base + 6}},
	}
	for index, event := range events {
		payload, err := json.Marshal(event.payload)
		require.NoError(t, err)
		_, err = f.database.Exec(`INSERT INTO run_events(run_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)`,
			identity.RunID, base+index+1, event.kind, string(payload), at.Add(time.Duration(index)*time.Millisecond))
		require.NoError(t, err)
	}
}
