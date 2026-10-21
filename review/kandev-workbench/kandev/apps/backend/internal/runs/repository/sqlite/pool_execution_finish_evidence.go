package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
)

func (r *Repository) poolFinishEvidenceTx(ctx context.Context, tx *sqlx.Tx, identity models.PoolExecutionIdentity) (*models.Run, *models.RunEvent, error) {
	run, err := r.GetRunByIDTx(ctx, tx, identity.RunID)
	if err != nil {
		return nil, nil, err
	}
	if run.Status != models.RunStatusClaimed && run.Status != models.RunStatusFinished || run.SessionID != identity.SessionID {
		return nil, nil, ErrPoolReceiptConflict
	}
	claimID, err := currentPoolClaimID(ctx, tx, run)
	if err != nil {
		return nil, nil, err
	}
	if claimID != identity.ClaimID {
		return nil, nil, ErrPoolReceiptConflict
	}
	allocation, err := poolFinishAllocationTx(ctx, tx, run, identity)
	if err != nil {
		return nil, nil, err
	}
	stopped, err := poolClaimEventsTx(ctx, tx, identity.RunID, identity.ClaimID, models.PoolExecutionStopped)
	if err != nil {
		return nil, nil, err
	}
	var receipt models.PoolExecutionStopReceipt
	if len(stopped) != 1 || json.Unmarshal([]byte(stopped[0].Payload), &receipt) != nil {
		return nil, nil, ErrPoolReceiptUnknown
	}
	activity := models.PoolExecutionActivity{TaskID: identity.TaskID, AgentProfileID: identity.AgentProfileID,
		SessionID: identity.SessionID, ExecutionID: identity.ExecutionID, TurnID: identity.TurnID,
		PromptGeneration: identity.PromptGeneration, AgentType: allocation.AgentType}
	expected, trusted := activity.StoppedReceipt(*allocation, receipt.Source, receipt.RuntimeInstanceID, true)
	if !trusted || receipt != expected {
		return nil, nil, ErrPoolReceiptUnknown
	}
	return run, &stopped[0], nil
}

func poolFinishAllocationTx(ctx context.Context, tx *sqlx.Tx, run *models.Run, identity models.PoolExecutionIdentity) (*models.PoolExecutionAllocation, error) {
	intents, err := poolClaimEventsTx(ctx, tx, identity.RunID, identity.ClaimID, models.PoolLaunchAdmitted)
	if err != nil {
		return nil, err
	}
	var request models.PoolClaimStart
	if len(intents) != 1 || json.Unmarshal([]byte(intents[0].Payload), &request) != nil ||
		request.RunID != identity.RunID || request.ClaimID != identity.ClaimID ||
		!request.Release.MatchesRun(run) || !identity.ValidAllocationFor(request) {
		return nil, ErrPoolReceiptUnknown
	}
	allocations, err := poolClaimEventsTx(ctx, tx, identity.RunID, identity.ClaimID, models.PoolExecutionAllocated)
	if err != nil {
		return nil, err
	}
	var allocation models.PoolExecutionAllocation
	if len(allocations) != 1 || json.Unmarshal([]byte(allocations[0].Payload), &allocation) != nil ||
		allocation.PoolExecutionIdentity != identity || allocation.AgentType == "" {
		return nil, ErrPoolReceiptUnknown
	}
	return &allocation, nil
}
