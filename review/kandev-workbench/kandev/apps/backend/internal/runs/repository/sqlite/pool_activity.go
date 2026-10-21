package sqlite

import (
	"context"
	"encoding/json"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
)

// HasPoolActivityCandidate 让普通非池流只做原生索引读取，不获得任务写锁。
func (r *Repository) HasPoolActivityCandidate(ctx context.Context, activity models.PoolExecutionActivity) (bool, error) {
	var found bool
	err := r.ro.GetContext(ctx, &found, r.ro.Rebind(`SELECT EXISTS (SELECT 1 FROM runs
		WHERE agent_profile_id = ? AND status = 'claimed' AND session_id = ? AND idempotency_key LIKE ?)`),
		activity.AgentProfileID, activity.SessionID, models.PoolDispatchKeyPrefix+"%")
	return found, err
}

// AppendPoolActivityTx 在当前领取与已分配执行匹配后，原子追加绑定和首个开工。
func (r *Repository) AppendPoolActivityTx(ctx context.Context, tx *sqlx.Tx, activity models.PoolExecutionActivity) (*models.RunEvent, error) {
	allocation, err := r.poolSignalAllocationTx(ctx, tx, activity)
	if err != nil || allocation == nil {
		return nil, err
	}
	identity, matches := activity.ReceiptIdentity(*allocation)
	if !matches || !validPoolIdentity(identity) {
		return nil, ErrPoolReceiptConflict
	}
	if err := r.lockPoolClaim(ctx, tx, identity); err != nil {
		return nil, err
	}
	if _, err := r.writePoolReceipt(ctx, tx, identity, ""); err != nil {
		return nil, err
	}
	return r.writePoolReceipt(ctx, tx, identity, activity.StartedSource)
}

// poolSignalAllocationTx 对所有协议证据使用同一份有界领取和分配核验。
func (r *Repository) poolSignalAllocationTx(ctx context.Context, tx *sqlx.Tx, activity models.PoolExecutionActivity) (*models.PoolExecutionAllocation, error) {
	var runs []*models.Run
	if err := tx.SelectContext(ctx, &runs, tx.Rebind(`SELECT * FROM runs WHERE agent_profile_id = ?
		AND status = 'claimed' AND session_id = ? AND idempotency_key LIKE ? LIMIT 2`),
		activity.AgentProfileID, activity.SessionID, models.PoolDispatchKeyPrefix+"%"); err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return nil, nil
	}
	if len(runs) != 1 {
		return nil, ErrPoolReceiptUnknown
	}
	run := runs[0]
	claimID, err := currentPoolClaimID(ctx, tx, run)
	if err != nil {
		return nil, err
	}
	request, err := (&models.ClaimedRun{Run: run, ClaimID: claimID}).PoolStartRequest()
	if err != nil {
		return nil, err
	}
	if err := requirePoolLaunchAdmissionTx(ctx, tx, request); err != nil {
		return nil, err
	}
	allocated, err := poolClaimEventsTx(ctx, tx, run.ID, claimID, models.PoolExecutionAllocated)
	if err != nil {
		return nil, err
	}
	var allocation models.PoolExecutionAllocation
	if len(allocated) != 1 || json.Unmarshal([]byte(allocated[0].Payload), &allocation) != nil ||
		!allocation.PoolExecutionIdentity.ValidAllocationFor(request) || allocation.SessionID != run.SessionID {
		return nil, ErrPoolReceiptUnknown
	}
	return &allocation, nil
}
