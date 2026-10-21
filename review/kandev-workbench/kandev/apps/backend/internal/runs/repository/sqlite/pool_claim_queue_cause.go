package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

func checkPoolClaimQueueCauseTx(ctx context.Context, tx *sqlx.Tx, run *models.Run, request models.PoolClaimStart) error {
	hasPrior, err := poolHasPriorClaimTx(ctx, tx, run.ID, request.ClaimID)
	if err != nil {
		return err
	}
	var last models.RunEvent
	err = tx.GetContext(ctx, &last, tx.Rebind(`SELECT * FROM run_events WHERE run_id=? AND event_type LIKE 'pool.%' ORDER BY seq DESC LIMIT 1`), run.ID)
	if errors.Is(err, sql.ErrNoRows) && !hasPrior {
		return nil
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrPoolReceiptUnknown
		}
		return err
	}
	var operation models.PoolRecoveryOperation
	if !hasPrior || last.EventType != models.PoolRecoveryRequeued || json.Unmarshal([]byte(last.Payload), &operation) != nil {
		return ErrPoolReceiptUnknown
	}
	prior := models.PoolClaimStart{RunID: run.ID, ClaimID: operation.ClaimID, Release: request.Release}
	if operation.Command.Action != "retry" || !operation.ValidExecutionFor(prior) || operation.ClaimID == request.ClaimID || operation.FinishedSeq >= last.Seq {
		return ErrPoolReceiptUnknown
	}
	if _, err := poolFinishAllocationTx(ctx, tx, run, operation.Execution); err != nil {
		return err
	}
	finished, err := poolClaimEventsTx(ctx, tx, run.ID, operation.ClaimID, models.PoolExecutionFinished)
	if err != nil {
		return err
	}
	var receipt models.PoolExecutionFinishReceipt
	if len(finished) != 1 || finished[0].Seq != operation.FinishedSeq || json.Unmarshal([]byte(finished[0].Payload), &receipt) != nil || receipt.PoolExecutionIdentity != operation.Execution {
		return ErrPoolReceiptUnknown
	}
	return nil
}

// PoolHasPriorClaimTx 只能在同事务原生准入已核对因果回执后用于选择候选资格，不能单独授权重试。
func (r *Repository) PoolHasPriorClaimTx(ctx context.Context, tx *sqlx.Tx, runID, claimID string) (bool, error) {
	return poolHasPriorClaimTx(ctx, tx, runID, claimID)
}

func poolHasPriorClaimTx(ctx context.Context, tx *sqlx.Tx, runID, claimID string) (bool, error) {
	var prior bool
	err := tx.GetContext(ctx, &prior, tx.Rebind(`SELECT EXISTS (SELECT 1 FROM office_launch_ledger WHERE run_id=? AND id<>?)`), runID, claimID)
	return prior, err
}
