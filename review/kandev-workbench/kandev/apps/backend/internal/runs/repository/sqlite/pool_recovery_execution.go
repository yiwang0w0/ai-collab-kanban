package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

// PoolRecoveryExecutionTx 从当前唯一账本和原生启动／分配事件恢复身份。
func (r *Repository) PoolRecoveryExecutionTx(ctx context.Context, tx *sqlx.Tx, run *models.Run, expectedClaim string) (models.PoolExecutionIdentity, error) {
	var identity models.PoolExecutionIdentity
	if run == nil || run.SessionID == "" || (run.Status != models.RunStatusClaimed && run.Status != models.RunStatusFinished) {
		return identity, models.ErrPoolRecoveryConflict
	}
	claimID, err := currentPoolClaimID(ctx, tx, run)
	if err != nil {
		return identity, err
	}
	if claimID != expectedClaim {
		return identity, models.ErrPoolRecoveryConflict
	}
	allocations, err := poolClaimEventsTx(ctx, tx, run.ID, claimID, models.PoolExecutionAllocated)
	if err != nil {
		return identity, err
	}
	var allocation models.PoolExecutionAllocation
	if len(allocations) != 1 || json.Unmarshal([]byte(allocations[0].Payload), &allocation) != nil {
		return identity, ErrPoolReceiptUnknown
	}
	identity = allocation.PoolExecutionIdentity
	if identity.RunID != run.ID || identity.ClaimID != claimID || identity.SessionID != run.SessionID {
		return models.PoolExecutionIdentity{}, models.ErrPoolRecoveryConflict
	}
	if _, err := poolFinishAllocationTx(ctx, tx, run, identity); err != nil {
		return models.PoolExecutionIdentity{}, err
	}
	return identity, nil
}

// AppendPoolRecoveryStopTx 只提交请求事实；不结束运行、不签发停止或 Done。
func (r *Repository) AppendPoolRecoveryStopTx(ctx context.Context, tx *sqlx.Tx, run *models.Run, operation models.PoolRecoveryOperation) (*models.RunEvent, error) {
	if run.Status != models.RunStatusClaimed || run.FinishedAt != nil || run.Outcome != nil ||
		operation.Command.Action != "stop" || operation.Result != "stop_requested" {
		return nil, models.ErrPoolRecoveryConflict
	}
	identity, err := r.PoolRecoveryExecutionTx(ctx, tx, run, operation.Command.ExpectedClaimID)
	if err != nil {
		return nil, err
	}
	if identity != operation.Execution {
		return nil, models.ErrPoolRecoveryConflict
	}
	encoded, err := json.Marshal(operation)
	if err != nil {
		return nil, err
	}
	return insertPoolEvent(ctx, tx, run.ID, models.PoolRecoveryStopRequested, string(encoded))
}

func (r *Repository) PoolRecoveryStopReceiptPresentTx(ctx context.Context, tx *sqlx.Tx, runID, claimID string) (bool, error) {
	var present bool
	err := tx.GetContext(ctx, &present, tx.Rebind(`SELECT EXISTS (SELECT 1 FROM run_events WHERE run_id=? AND event_type=?
		AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.claim_id')=? ELSE 1 END)`), runID, models.PoolExecutionStopped, claimID)
	return present, err
}
