package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/runs/models"
)

// CheckPoolRetryEvidenceTx 是只读检查；停止 ACK、超时或缺失资源都不能替代真实停止证据。
func (r *Repository) CheckPoolRetryEvidenceTx(ctx context.Context, tx *sqlx.Tx, identity models.PoolExecutionIdentity) error {
	run, stopped, err := r.poolFinishEvidenceTx(ctx, tx, identity)
	if err != nil {
		return err
	}
	finished, err := poolClaimEventsTx(ctx, tx, identity.RunID, identity.ClaimID, models.PoolExecutionFinished)
	if err != nil {
		return err
	}
	if len(finished) == 1 {
		_, err = replayPoolExecutionFinish(run, finished[0], models.PoolExecutionFinishReceipt{PoolExecutionIdentity: identity, StoppedSeq: stopped.Seq})
		return err
	}
	if len(finished) != 0 || run.Status != models.RunStatusClaimed || run.FinishedAt != nil || run.Outcome != nil {
		return models.ErrPoolRecoveryConflict
	}
	return nil
}

// RequeueStoppedPoolRunTx 复用原生终结和运行行；保留账本与旧事件，不签发主卡 Done。
func (r *Repository) RequeueStoppedPoolRunTx(ctx context.Context, tx *sqlx.Tx, operation models.PoolRecoveryOperation) (*models.RunEvent, error) {
	finished, err := r.FinalizeStoppedPoolRunTx(ctx, tx, operation.Execution)
	if err != nil {
		return nil, err
	}
	operation.FinishedSeq = finished.Seq
	run, err := r.GetRunByIDTx(ctx, tx, operation.Command.RunID)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(operation)
	if err != nil {
		return nil, err
	}
	event, err := insertPoolEvent(ctx, tx, run.ID, models.PoolRecoveryRequeued, string(encoded))
	if err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE runs SET status='queued',claimed_at=NULL,finished_at=NULL,
		session_id='',outcome=NULL,cancel_reason=NULL,scheduled_retry_at=NULL,earliest_retry_at=NULL,routing_blocked_status=NULL,
		resolved_execution_profile_id=NULL,resolved_provider_id=NULL,resolved_model=NULL,
		route_cycle_baseline_seq=current_route_attempt_seq,error_message='',failure_reason='',output_summary='',result_json='{}'
		WHERE id=? AND status='finished' AND outcome=? AND claimed_at=? AND session_id=? AND finished_at=?`),
		run.ID, models.PoolOutcomeExecutionStopped, run.ClaimedAt, operation.Execution.SessionID, finished.CreatedAt)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, models.ErrPoolRecoveryConflict
	}
	return event, nil
}
