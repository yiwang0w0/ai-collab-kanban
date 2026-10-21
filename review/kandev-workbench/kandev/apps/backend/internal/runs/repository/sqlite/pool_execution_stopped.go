package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
)

func (r *Repository) AppendPoolExecutionStoppedTx(ctx context.Context, tx *sqlx.Tx, activity models.PoolExecutionActivity, source, runtimeInstanceID string, released bool) (*models.RunEvent, error) {
	allocation, err := r.poolSignalAllocationTx(ctx, tx, activity)
	if err != nil || allocation == nil {
		return nil, err
	}
	receipt, trusted := activity.StoppedReceipt(*allocation, source, runtimeInstanceID, released)
	if !trusted {
		return nil, ErrPoolReceiptConflict
	}
	if err := r.lockPoolClaim(ctx, tx, receipt.PoolExecutionIdentity); err != nil {
		return nil, err
	}
	previous, err := poolClaimEventsTx(ctx, tx, receipt.RunID, receipt.ClaimID, models.PoolExecutionStopped)
	if err != nil {
		return nil, err
	}
	if len(previous) > 1 {
		return nil, ErrPoolReceiptUnknown
	}
	if len(previous) == 1 {
		var stored models.PoolExecutionStopReceipt
		if json.Unmarshal([]byte(previous[0].Payload), &stored) != nil || stored != receipt {
			return nil, ErrPoolReceiptConflict
		}
		return &previous[0], nil
	}
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	return insertPoolEvent(ctx, tx, receipt.RunID, models.PoolExecutionStopped, string(encoded))
}
