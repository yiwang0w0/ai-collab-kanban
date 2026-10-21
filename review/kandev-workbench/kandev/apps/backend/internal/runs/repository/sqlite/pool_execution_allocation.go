package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
)

// AppendPoolExecutionAllocationTx 与任务原生校验共享同一事务；记录不等于工作活动。
func (r *Repository) AppendPoolExecutionAllocationTx(ctx context.Context, tx *sqlx.Tx, request models.PoolClaimStart, allocation models.PoolExecutionAllocation) (*models.RunEvent, error) {
	identity := allocation.PoolExecutionIdentity
	if !identity.ValidAllocationFor(request) || allocation.AgentType == "" {
		return nil, models.ErrPoolClaimStartConflict
	}
	if err := r.lockPoolClaim(ctx, tx, identity); err != nil {
		return nil, err
	}
	run, err := r.GetRunByIDTx(ctx, tx, request.RunID)
	if err != nil {
		return nil, err
	}
	if !request.Release.MatchesRun(run) {
		return nil, models.ErrPoolClaimStartConflict
	}
	if err := requirePoolLaunchAdmissionTx(ctx, tx, request); err != nil {
		return nil, err
	}
	previous, err := poolClaimEventsTx(ctx, tx, identity.RunID, identity.ClaimID, models.PoolExecutionAllocated)
	if err != nil {
		return nil, err
	}
	if len(previous) == 1 {
		var stored models.PoolExecutionAllocation
		if json.Unmarshal([]byte(previous[0].Payload), &stored) != nil || stored != allocation || run.SessionID != identity.SessionID {
			return nil, ErrPoolReceiptConflict
		}
		return &previous[0], nil
	}
	if run.SessionID != "" {
		return nil, ErrPoolReceiptConflict
	}
	encoded, err := json.Marshal(allocation)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE runs SET session_id = ? WHERE id = ?`), identity.SessionID, identity.RunID); err != nil {
		return nil, err
	}
	return insertPoolEvent(ctx, tx, identity.RunID, models.PoolExecutionAllocated, string(encoded))
}

func requirePoolLaunchAdmissionTx(ctx context.Context, tx *sqlx.Tx, request models.PoolClaimStart) error {
	events, err := poolClaimEventsTx(ctx, tx, request.RunID, request.ClaimID, models.PoolLaunchAdmitted)
	if err != nil {
		return err
	}
	var stored models.PoolClaimStart
	if len(events) != 1 || json.Unmarshal([]byte(events[0].Payload), &stored) != nil || stored != request {
		return ErrPoolReceiptUnknown
	}
	return nil
}

func poolClaimEventsTx(ctx context.Context, tx *sqlx.Tx, runID, claimID, kind string) ([]models.RunEvent, error) {
	var events []models.RunEvent
	if err := tx.SelectContext(ctx, &events, tx.Rebind(`SELECT * FROM run_events WHERE run_id = ? AND event_type = ?
		AND json_extract(payload, '$.claim_id') = ? ORDER BY seq LIMIT 2`), runID, kind, claimID); err != nil {
		return nil, err
	}
	if len(events) > 1 {
		return nil, ErrPoolReceiptUnknown
	}
	return events, nil
}
