package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
)

// AppendPoolTurnEndTx 可先于独立订阅的工作帧落盘，但绝不补写开工或释放领取。
func (r *Repository) AppendPoolTurnEndTx(ctx context.Context, tx *sqlx.Tx, activity models.PoolExecutionActivity, failed bool) (*models.RunEvent, error) {
	allocation, err := r.poolSignalAllocationTx(ctx, tx, activity)
	if err != nil || allocation == nil {
		return nil, err
	}
	identity, matches := activity.TurnEndIdentity(*allocation)
	if !matches || !validPoolIdentity(identity) {
		return nil, ErrPoolReceiptConflict
	}
	if err := r.lockPoolClaim(ctx, tx, identity); err != nil {
		return nil, err
	}
	if _, err := r.writePoolReceipt(ctx, tx, identity, ""); err != nil {
		return nil, err
	}
	outcome := models.PoolTurnCompleted
	if failed {
		outcome = models.PoolTurnFailed
	}
	previous, err := findPoolReceipt(ctx, tx, identity, models.PoolTurnEnded)
	if err != nil {
		return nil, err
	}
	if previous != nil {
		var stored models.PoolTurnEndReceipt
		if json.Unmarshal([]byte(previous.Payload), &stored) != nil || stored.Outcome != outcome {
			return nil, ErrPoolReceiptConflict
		}
		return previous, nil
	}
	encoded, err := json.Marshal(models.PoolTurnEndReceipt{PoolExecutionIdentity: identity, Outcome: outcome})
	if err != nil {
		return nil, err
	}
	return insertPoolEvent(ctx, tx, identity.RunID, models.PoolTurnEnded, string(encoded))
}
